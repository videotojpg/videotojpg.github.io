import React, { useState, useRef, useCallback } from 'react';
import { Upload, Settings, Play, Image as ImageIcon, Download, Trash2, X, CheckCircle2, AlertCircle, FileVideo, ChevronRight, Loader2, FileArchive, Settings2, LayoutGrid, ChevronDown, ChevronUp, Wand2 } from 'lucide-react';
import JSZip from 'jszip';
import fileSaver from 'file-saver';
const { saveAs } = fileSaver;
import { cn, formatTime, formatBytes } from '../lib/utils';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const ACCEPTED_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska'];

const getPixelDiff = (data1, data2) => {
  let diff = 0;
  // Compare every 4th pixel (step by 16 array indices) to speed up significantly
  for (let i = 0; i < data1.length; i += 16) {
    const rDiff = Math.abs(data1[i] - data2[i]);
    const gDiff = Math.abs(data1[i+1] - data2[i+1]);
    const bDiff = Math.abs(data1[i+2] - data2[i+2]);
    diff += rDiff + gDiff + bDiff;
  }
  // Total checked pixels = length / 16. Max diff per pixel = 255 * 3
  return diff / ((data1.length / 16) * 255 * 3); 
};

export default function VideoToJpg() {
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  
  const [videoMeta, setVideoMeta] = useState(null);
  
  // Standard Settings
  const [fps, setFps] = useState('1');
  const [format, setFormat] = useState('image/jpeg');
  const [quality, setQuality] = useState(0.92);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  
  // Advanced Settings
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [filter, setFilter] = useState('none');
  const [watermarkText, setWatermarkText] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(false);
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [frames, setFrames] = useState([]);
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const diffCanvasRef = useRef(null);
  const abortControllerRef = useRef(null);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const validateAndSetFile = (selectedFile) => {
    setError('');
    if (!selectedFile) return;
    
    if (!ACCEPTED_TYPES.includes(selectedFile.type) && !selectedFile.name.match(/\.(mp4|webm|ogg|mov|mkv)$/i)) {
      setError('Unsupported file type. Please upload MP4, WebM, or MOV.');
      return;
    }
    
    if (selectedFile.size > MAX_FILE_SIZE) {
      setError(`File size exceeds 100MB limit (${formatBytes(selectedFile.size)}).`);
      return;
    }

    setFile(selectedFile);
    loadVideoMeta(selectedFile);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      validateAndSetFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      validateAndSetFile(e.target.files[0]);
    }
  };

  const loadVideoMeta = (videoFile) => {
    const url = URL.createObjectURL(videoFile);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      setVideoMeta({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        url: url
      });
      setEndTime(video.duration);
    };
    video.src = url;
  };

  const clearAll = () => {
    if (videoMeta && videoMeta.url) {
      URL.revokeObjectURL(videoMeta.url);
    }
    frames.forEach(f => URL.revokeObjectURL(f.url));
    setFile(null);
    setVideoMeta(null);
    setFrames([]);
    setError('');
    setProgress(0);
    setStatusText('');
    setStartTime(0);
    setEndTime(0);
  };

  const cancelProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsProcessing(false);
      setStatusText('Processing cancelled.');
    }
  };

  const extractFrames = async () => {
    if (!videoMeta || !file) return;
    
    setFrames([]);
    setIsProcessing(true);
    setProgress(0);
    setError('');
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      const diffCanvas = diffCanvasRef.current;
      const diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true });
      
      canvas.width = videoMeta.width;
      canvas.height = videoMeta.height;
      diffCanvas.width = 64;
      diffCanvas.height = 64;

      let interval = 1;
      let totalFrames = 1;
      
      const start = Math.max(0, Number(startTime));
      const end = Math.min(videoMeta.duration, Number(endTime));
      const duration = end - start;

      if (fps === 'custom') {
        interval = duration + 1; 
        totalFrames = 1;
      } else if (fps === 'all') {
        interval = 1 / 30;
        totalFrames = Math.floor(duration * 30) || 1;
      } else {
        const fpsNum = Number(fps);
        interval = 1 / fpsNum;
        totalFrames = Math.floor(duration * fpsNum) || 1;
      }

      const extracted = [];
      let currentFrame = 0;
      let currentTime = start;
      let previousImageData = null;
      let skippedCount = 0;

      video.src = videoMeta.url;
      await new Promise(resolve => {
        video.onloadeddata = resolve;
        video.load();
      });

      while (currentTime <= end && currentFrame < totalFrames) {
        if (signal.aborted) throw new Error('Aborted');

        setStatusText(`Extracting frame ${currentFrame + 1} of ${totalFrames}...${skippedCount > 0 ? ` (${skippedCount} duplicates skipped)` : ''}`);
        setProgress(Math.round(((currentFrame) / totalFrames) * 100));

        video.currentTime = currentTime;
        
        await new Promise((resolve, reject) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            resolve();
          };
          const onError = (e) => {
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            reject(video.error);
          };
          video.addEventListener('seeked', onSeeked);
          video.addEventListener('error', onError);
        });

        if (signal.aborted) throw new Error('Aborted');

        // Feature 3: Smart Skip Duplicate Frames
        let skipThisFrame = false;
        if (skipDuplicates) {
          diffCtx.drawImage(video, 0, 0, 64, 64);
          const currentData = diffCtx.getImageData(0, 0, 64, 64).data;
          
          if (previousImageData) {
            const diff = getPixelDiff(previousImageData, currentData);
            if (diff < 0.02) { // Less than 2% difference -> duplicate
              skipThisFrame = true;
            }
          }
          if (!skipThisFrame) {
            previousImageData = currentData;
          }
        }

        if (skipThisFrame) {
          skippedCount++;
        } else {
          // Draw Main Frame
          if (filter !== 'none') {
            ctx.filter = filter;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          ctx.filter = 'none';
          
          // Feature 2: Watermarking
          if (watermarkText.trim()) {
            const fontSize = Math.max(20, Math.floor(canvas.width * 0.04)); // Responsive font size
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
            ctx.shadowBlur = 4;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            const padding = Math.floor(canvas.width * 0.02);
            ctx.fillText(watermarkText.trim(), canvas.width - padding, canvas.height - padding);
            ctx.shadowBlur = 0; // Reset
          }

          const blob = await new Promise(resolve => {
            canvas.toBlob(resolve, format, Number(quality));
          });

          if (blob) {
            const url = URL.createObjectURL(blob);
            const extension = format === 'image/jpeg' ? 'jpg' : format === 'image/png' ? 'png' : 'webp';
            const filename = `frame_${formatTime(currentTime).replace(/[:.]/g, '-')}.${extension}`;
            
            extracted.push({
              id: currentFrame,
              url,
              blob,
              time: currentTime,
              filename
            });
          }
        }

        currentFrame++;
        currentTime += interval;
        await new Promise(r => setTimeout(r, 5)); 
      }

      setFrames(extracted);
      setProgress(100);
      setStatusText(`Successfully extracted ${extracted.length} frames.${skippedCount > 0 ? ` Skipped ${skippedCount} duplicates.` : ''}`);
    } catch (err) {
      if (err.message === 'Aborted') {
        setStatusText('Extraction cancelled.');
      } else {
        console.error(err);
        setError('An error occurred during extraction.');
        setStatusText('');
      }
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  };

  const downloadAllZip = async () => {
    if (frames.length === 0) return;
    
    setIsProcessing(true);
    setStatusText('Zipping frames...');
    setProgress(0);
    
    try {
      const zip = new JSZip();
      frames.forEach((frame) => {
        zip.file(frame.filename, frame.blob);
      });
      
      const content = await zip.generateAsync({ 
        type: 'blob',
        compression: 'STORE' 
      }, (metadata) => {
        setProgress(metadata.percent);
      });
      
      saveAs(content, `extracted_frames_${Date.now()}.zip`);
      setStatusText('Download complete!');
    } catch (err) {
      console.error(err);
      setError('Failed to create ZIP file.');
    } finally {
      setIsProcessing(false);
      setTimeout(() => setStatusText(''), 3000);
    }
  };

  // Feature 4: Storyboard Generator
  const downloadStoryboard = async () => {
    if (frames.length === 0) return;
    setIsProcessing(true);
    setStatusText('Generating Storyboard...');
    setProgress(0);

    try {
      const cols = Math.ceil(Math.sqrt(frames.length));
      const rows = Math.ceil(frames.length / cols);
      
      // Limit thumb width to prevent massive canvas crashes (max ~4000px wide)
      const maxThumbWidth = 320; 
      const originalRatio = videoMeta.width / videoMeta.height;
      const thumbWidth = Math.min(maxThumbWidth, videoMeta.width);
      const thumbHeight = thumbWidth / originalRatio;
      
      const boardCanvas = document.createElement('canvas');
      boardCanvas.width = cols * thumbWidth;
      boardCanvas.height = rows * thumbHeight;
      const bCtx = boardCanvas.getContext('2d');
      
      bCtx.fillStyle = '#0f172a'; // slate-900 background
      bCtx.fillRect(0, 0, boardCanvas.width, boardCanvas.height);
      
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = frame.url;
        });
        
        const x = (i % cols) * thumbWidth;
        const y = Math.floor(i / cols) * thumbHeight;
        
        bCtx.drawImage(img, x, y, thumbWidth, thumbHeight);
        
        // Progress text
        bCtx.fillStyle = 'rgba(0,0,0,0.6)';
        const textHeight = Math.max(12, thumbHeight * 0.08);
        bCtx.fillRect(x, y + thumbHeight - textHeight - 4, thumbWidth, textHeight + 4);
        bCtx.font = `${textHeight}px monospace`;
        bCtx.fillStyle = 'white';
        bCtx.textAlign = 'left';
        bCtx.textBaseline = 'bottom';
        bCtx.fillText(formatTime(frame.time), x + 4, y + thumbHeight - 2);

        setProgress(Math.round(((i + 1) / frames.length) * 100));
      }
      
      boardCanvas.toBlob((blob) => {
        saveAs(blob, `storyboard_${Date.now()}.jpg`);
        setIsProcessing(false);
        setStatusText('Storyboard Downloaded!');
        setTimeout(() => setStatusText(''), 3000);
      }, 'image/jpeg', 0.9);
      
    } catch (err) {
      console.error(err);
      setError('Failed to generate storyboard.');
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Hidden elements for processing */}
      <video ref={videoRef} className="hidden" muted playsInline />
      <canvas ref={canvasRef} className="hidden" />
      <canvas ref={diffCanvasRef} className="hidden" />

      {/* Upload Zone */}
      {!file && (
        <div 
          className={cn(
            "border-2 border-dashed rounded-2xl p-12 text-center transition-all duration-200 cursor-pointer",
            isDragging 
              ? "border-blue-500 bg-blue-50 shadow-md" 
              : "border-slate-300 bg-white hover:border-blue-400 hover:bg-slate-50 hover:shadow-sm"
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => document.getElementById('file-upload').click()}
        >
          <input 
            id="file-upload" 
            type="file" 
            accept={ACCEPTED_TYPES.join(',')} 
            className="hidden" 
            onChange={handleFileChange}
            aria-label="Upload video file"
          />
          <div className="w-20 h-20 mx-auto bg-blue-100 rounded-full flex items-center justify-center mb-6">
            <Upload className="w-10 h-10 text-blue-600" />
          </div>
          <h3 className="text-2xl font-bold text-slate-900 mb-2">Drag & Drop your video here</h3>
          <p className="text-slate-500 mb-6 max-w-md mx-auto">
            or click to browse from your device. Supports MP4, WebM, and MOV up to 100MB.
          </p>
          <div className="inline-flex items-center justify-center px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-semibold shadow-sm transition-colors">
            Select Video File
          </div>
          {error && (
            <div className="mt-6 flex items-center justify-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg max-w-md mx-auto">
              <AlertCircle className="w-5 h-5" />
              <span className="text-sm font-medium">{error}</span>
            </div>
          )}
        </div>
      )}

      {/* Configuration & Processing */}
      {file && videoMeta && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* Left Column: Settings */}
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 transition-all">
              <div className="flex items-start justify-between mb-6 gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                    <Settings2 className="w-5 h-5 text-blue-600 shrink-0" />
                    <span className="truncate">Extraction Settings</span>
                  </h3>
                  <div className="flex items-center gap-1 sm:gap-2 text-sm text-slate-500 mt-1">
                    <FileVideo className="w-4 h-4 shrink-0" />
                    <span className="truncate flex-1 max-w-[150px] sm:max-w-[250px]" title={file.name}>{file.name}</span>
                    <span className="shrink-0">({formatBytes(file.size)})</span>
                  </div>
                </div>
                <button 
                  onClick={clearAll}
                  className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                  title="Clear and upload new file"
                  disabled={isProcessing}
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-5">
                {/* FPS Selector */}
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">Frame Rate (FPS)</label>
                  <select 
                    value={fps} 
                    onChange={(e) => setFps(e.target.value)}
                    disabled={isProcessing}
                    aria-label="Frame Rate Selection"
                    className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-shadow disabled:opacity-50"
                  >
                    <option value="1">1 frame per second (1 FPS)</option>
                    <option value="2">2 frames per second (2 FPS)</option>
                    <option value="5">5 frames per second (5 FPS)</option>
                    <option value="10">10 frames per second (10 FPS)</option>
                    <option value="15">15 frames per second (15 FPS)</option>
                    <option value="all">Every frame (~30 FPS)</option>
                    <option value="custom">Single Frame (at Start Time)</option>
                  </select>
                </div>

                {/* Format & Quality */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">Image Format</label>
                    <select 
                      value={format} 
                      onChange={(e) => setFormat(e.target.value)}
                      disabled={isProcessing}
                      aria-label="Image Format Selection"
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-shadow disabled:opacity-50"
                    >
                      <option value="image/jpeg">JPG</option>
                      <option value="image/png">PNG</option>
                      <option value="image/webp">WebP</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-2">Quality: {Math.round(quality * 100)}%</label>
                    <input 
                      type="range" 
                      min="0.5" 
                      max="1.0" 
                      step="0.05" 
                      value={quality}
                      onChange={(e) => setQuality(Number(e.target.value))}
                      disabled={isProcessing || format === 'image/png'}
                      aria-label={`Image Quality: ${Math.round(quality * 100)}%`}
                      className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer disabled:opacity-50 accent-blue-600 mt-3"
                    />
                  </div>
                </div>

                {/* Time Range */}
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">Time Range (Seconds)</label>
                  <div className="flex flex-col sm:flex-row items-center gap-3">
                    <div className="w-full relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold uppercase">Start</span>
                      <input 
                        type="number" 
                        min="0" 
                        max={endTime} 
                        step="0.1"
                        value={startTime}
                        onChange={(e) => setStartTime(Number(e.target.value))}
                        disabled={isProcessing}
                        aria-label="Start time in seconds"
                        className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-xl pl-14 pr-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:opacity-50 font-mono text-sm"
                      />
                    </div>
                    <span className="hidden sm:block text-slate-400 font-bold">-</span>
                    <div className="w-full relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold uppercase">End</span>
                      <input 
                        type="number" 
                        min={startTime} 
                        max={videoMeta.duration.toFixed(2)} 
                        step="0.1"
                        value={endTime}
                        onChange={(e) => setEndTime(Number(e.target.value))}
                        disabled={isProcessing || fps === 'custom'}
                        aria-label="End time in seconds"
                        className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-xl pl-12 pr-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none disabled:opacity-50 font-mono text-sm"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 mt-2 text-right">Max duration: {formatTime(videoMeta.duration)}</p>
                </div>

                {/* Advanced Options Accordion */}
                <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50/50">
                  <button 
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-slate-100/50 hover:bg-slate-100 text-slate-700 font-semibold text-sm transition-colors"
                  >
                    <span className="flex items-center gap-2"><Wand2 className="w-4 h-4 text-blue-600" /> Advanced Options</span>
                    {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  
                  {showAdvanced && (
                    <div className="p-4 space-y-4 border-t border-slate-200">
                      {/* Feature 1: Filters */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Color Filter</label>
                        <select 
                          value={filter} 
                          onChange={(e) => setFilter(e.target.value)}
                          disabled={isProcessing}
                          aria-label="Color Filter Selection"
                          className="w-full bg-white border border-slate-300 text-slate-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-shadow disabled:opacity-50"
                        >
                          <option value="none">None</option>
                          <option value="grayscale(100%)">Grayscale</option>
                          <option value="sepia(100%)">Sepia</option>
                          <option value="contrast(200%)">High Contrast</option>
                        </select>
                      </div>
                      
                      {/* Feature 2: Watermark */}
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1">Watermark Text</label>
                        <input 
                          type="text" 
                          placeholder="e.g. MyBrand" 
                          value={watermarkText}
                          onChange={(e) => setWatermarkText(e.target.value)}
                          disabled={isProcessing}
                          aria-label="Watermark Text Input"
                          className="w-full bg-white border border-slate-300 text-slate-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-shadow disabled:opacity-50"
                        />
                      </div>

                      {/* Feature 3: Skip Duplicates */}
                      <div className="flex items-center justify-between pt-1">
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold text-slate-700">Smart Skip</span>
                          <span className="text-xs text-slate-500">Skip identical adjacent frames</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={skipDuplicates}
                          disabled={isProcessing}
                          onClick={() => setSkipDuplicates(!skipDuplicates)}
                          className={cn(
                            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
                            skipDuplicates ? 'bg-blue-600' : 'bg-slate-300'
                          )}
                        >
                          <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white transition-transform", skipDuplicates ? 'translate-x-6' : 'translate-x-1')} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="pt-4 border-t border-slate-100">
                  {!isProcessing ? (
                    <button
                      onClick={extractFrames}
                      className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-6 py-3.5 font-bold shadow-sm transition-all active:scale-[0.98]"
                    >
                      <Play className="w-5 h-5 fill-current" />
                      Extract Frames
                    </button>
                  ) : (
                    <button
                      onClick={cancelProcessing}
                      className="w-full flex items-center justify-center gap-2 bg-red-100 hover:bg-red-200 text-red-700 rounded-xl px-6 py-3.5 font-bold shadow-sm transition-colors"
                    >
                      <X className="w-5 h-5" />
                      Cancel Processing
                    </button>
                  )}
                </div>
              </div>
            </div>
            
            {/* Resolution Info */}
            <div className="bg-blue-50 rounded-2xl p-5 border border-blue-100 flex items-start gap-3">
              <ImageIcon className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div className="text-sm text-blue-900">
                <p className="font-semibold mb-1">Native Resolution Maintained</p>
                <p className="text-blue-700/80">Frames will be extracted at exactly <strong>{videoMeta.width} &times; {videoMeta.height}</strong> pixels.</p>
              </div>
            </div>
          </div>

          {/* Right Column: Preview & Output */}
          <div className="lg:col-span-7 flex flex-col min-h-[400px]">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full overflow-hidden">
              <div className="px-4 sm:px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between bg-slate-50/50 gap-4">
                <h3 className="font-bold text-slate-900 flex items-center gap-2 shrink-0">
                  <ImageIcon className="w-5 h-5 text-blue-600" />
                  Extracted Frames
                  {frames.length > 0 && (
                    <span className="bg-blue-100 text-blue-700 text-xs py-0.5 px-2 rounded-full font-bold ml-2">
                      {frames.length}
                    </span>
                  )}
                </h3>
                {frames.length > 0 && !isProcessing && (
                  <div className="flex flex-wrap gap-2 w-full sm:w-auto mt-2 sm:mt-0 justify-start sm:justify-end shrink-0">
                    <button
                      onClick={downloadStoryboard}
                      className="flex items-center gap-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-3 py-2 rounded-lg text-sm font-semibold transition-colors"
                    >
                      <LayoutGrid className="w-4 h-4 text-blue-600" />
                      <span className="hidden sm:inline">Storyboard</span>
                    </button>
                    <button
                      onClick={downloadAllZip}
                      className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                    >
                      <FileArchive className="w-4 h-4" />
                      Download ZIP
                    </button>
                  </div>
                )}
              </div>
              
              <div className="p-6 flex-grow flex flex-col bg-slate-50/30">
                {/* Progress State */}
                {(isProcessing || (statusText && frames.length === 0)) && (
                  <div className="flex-grow flex flex-col items-center justify-center py-12 max-w-md mx-auto w-full">
                    {isProcessing ? (
                      <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mb-4" />
                    ) : (
                      <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-4" />
                    )}
                    <p className="font-medium text-slate-900 mb-6 text-center">{statusText}</p>
                    {isProcessing && (
                      <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                        <div 
                          className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300 ease-out" 
                          style={{ width: `${progress}%` }}
                        ></div>
                      </div>
                    )}
                  </div>
                )}

                {/* Empty State */}
                {!isProcessing && frames.length === 0 && !statusText && (
                  <div className="flex-grow flex flex-col items-center justify-center py-12 text-center opacity-60">
                    <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4 border border-slate-200">
                      <ImageIcon className="w-8 h-8 text-slate-400" />
                    </div>
                    <p className="font-medium text-slate-600">No frames extracted yet.</p>
                    <p className="text-sm text-slate-400 mt-1">Configure your settings and click extract.</p>
                  </div>
                )}

                {/* Gallery */}
                {!isProcessing && frames.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 overflow-y-auto max-h-[600px] pr-2 custom-scrollbar">
                    {frames.map((frame) => (
                      <div key={frame.id} className="group relative bg-slate-200 rounded-xl overflow-hidden aspect-video border border-slate-200 shadow-sm">
                        <img 
                          src={frame.url} 
                          alt={`Frame at ${formatTime(frame.time)}`} 
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                        <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 backdrop-blur-sm">
                          <a 
                            href={frame.url} 
                            download={frame.filename}
                            className="bg-white/10 hover:bg-white/20 text-white p-2 rounded-lg backdrop-blur-md transition-colors"
                            title="Download frame"
                          >
                            <Download className="w-5 h-5" />
                          </a>
                        </div>
                        <div className="absolute bottom-2 left-2 right-2 flex justify-between items-center pointer-events-none">
                          <span className="bg-black/60 text-white text-[10px] font-mono px-1.5 py-0.5 rounded backdrop-blur-md">
                            {formatTime(frame.time)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
