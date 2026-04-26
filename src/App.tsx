import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Square, Loader2, FileAudio, LogIn, Globe, History, X, FileText, Play, Pause, Trash2, CheckCircle2, ListChecks, Combine, ExternalLink, FolderOpen, Upload, Pencil } from 'lucide-react';
import { initOAuth, uploadToDrive, createGoogleDoc, appendToGoogleDoc, getTodaysFiles, DriveFile, getToken, deleteDriveFile, exportDocAsText, getOrCreateFolder, renameFile } from './services/googleService';
import { processAudioWithGemini, mergeDocumentsWithGemini } from './services/aiService';
import { translations, Language } from './translations';
import { motion, AnimatePresence } from 'motion/react';

const DriveIcon = ({ className = "w-5 h-5" }: { className?: string }) => (
  <ExternalLink className={className} />
);

export default function App() {
  const [language, setLanguage] = useState<Language>('zh');
  const t = translations[language];
  const renderText = (key: string) => t[key as keyof typeof t] || key;

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [statusText, setStatusText] = useState('readyToRecord');
  const [lastDocId, setLastDocId] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string>('');

  const autoProcess = true;
  const [pendingAudio, setPendingAudio] = useState<{blob: Blob, mimeType: string} | null>(null);

  const folderName = 'Voice Memos';
  const [folderId, setFolderId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const startTimeRef = useRef<number>(0);

  const [historyFiles, setHistoryFiles] = useState<DriveFile[]>([]);
  const [activeTab, setActiveTab] = useState<'audio' | 'document'>('audio');
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>('');
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [editFileName, setEditFileName] = useState('');
  
  const [playingFileId, setPlayingFileId] = useState<string | null>(null);
  const playAudioRef = useRef<HTMLAudioElement | null>(null);

  const [deleteToasts, setDeleteToasts] = useState<{id: string, file: DriveFile}[]>([]);
  const pendingDeletesRef = useRef<Record<string, NodeJS.Timeout>>({});

  useEffect(() => {
    // Look for autostart
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === 'true' && isAuthenticated) {
      startRecording();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      getOrCreateFolder(folderName).then(setFolderId).catch(console.error);
    }
  }, [isAuthenticated, folderName]);

  const fetchLatestFilesSilently = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const files = await getTodaysFiles(folderName);
      setHistoryFiles(prev => {
        // Merge fetched files with existing prev files to prevent optimistic files from disappearing due to index lag
        const fileMap = new Map(files.map(f => [f.id, f]));
        // Keep files from prev that are not in fetched list but were added optimistically
        prev.forEach(p => {
          if (!fileMap.has(p.id)) {
            fileMap.set(p.id, p);
          }
        });
        return Array.from(fileMap.values()).sort((a,b) => new Date(b.createdTime || 0).getTime() - new Date(a.createdTime || 0).getTime());
      });
    } catch (e) {
      console.error(e);
    }
  }, [isAuthenticated, folderName]);

  useEffect(() => {
    fetchLatestFilesSilently();
  }, [fetchLatestFilesSilently]);

  const latestFile = historyFiles[0];
  const latestPreviewUrl = latestFile ? (latestFile.webViewLink?.includes('/view') ? latestFile.webViewLink.replace('/view', '/preview') : latestFile.webViewLink?.replace('/edit', '/preview')) : null;

  const openPreview = (file: DriveFile, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (isSelecting && activeTab === 'document') {
      setSelectedFileIds(prev => 
        prev.includes(file.id) ? prev.filter(id => id !== file.id) : [...prev, file.id]
      );
      return;
    }
    
    let url = file.webViewLink || '';
    if (url.includes('/view')) {
      url = url.replace('/view', '/preview');
    } else if (url.includes('/edit')) {
      url = url.replace('/edit', '/preview');
    }
    
    setPreviewName(file.name);
    setPreviewUrl(url);
    setPreviewFileId(file.id);
    setIsRenaming(false);
  };

  const togglePlay = async (file: DriveFile, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (playingFileId === file.id) {
      if (playAudioRef.current) {
        playAudioRef.current.pause();
      }
      setPlayingFileId(null);
    } else {
      if (playAudioRef.current) {
        playAudioRef.current.pause();
      }
      setPlayingFileId(file.id);
      
      try {
        const token = getToken();
        if (!token) return;
        
        const audioUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
        const response = await fetch(audioUrl, {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });
        
        if (!response.ok) throw new Error("Failed to fetch audio");
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        
        const audio = new Audio(blobUrl);
        audio.onended = () => {
          if (playAudioRef.current === audio) setPlayingFileId(null);
        };
        
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((err: any) => {
            if (err.name !== 'AbortError' && !err.message?.includes('interrupted')) {
              console.error("Playback error", err);
            }
            if (playAudioRef.current === audio) {
              setPlayingFileId(null);
            }
          });
        }
        
        playAudioRef.current = audio;
      } catch (err) {
        console.error("Failed to play audio", err);
        setPlayingFileId(null);
      }
    }
  };

  const handleDelete = async (file: DriveFile, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Optimistic remove
    setHistoryFiles(prev => prev.filter(f => f.id !== file.id));

    if (playingFileId === file.id && playAudioRef.current) {
      playAudioRef.current.pause();
      setPlayingFileId(null);
    }

    const toastId = Math.random().toString(36).substring(7);
    setDeleteToasts(prev => [...prev, { id: toastId, file }]);

    const timeoutId = setTimeout(async () => {
      setDeleteToasts(prev => prev.filter(t => t.id !== toastId));
      try {
        await deleteDriveFile(file.id);
      } catch (err) {
        console.error(err);
        fetchLatestFilesSilently();
      }
      delete pendingDeletesRef.current[toastId];
    }, 5000);

    pendingDeletesRef.current[toastId] = timeoutId;
  };

  const undoDelete = (toastId: string, file: DriveFile) => {
    if (pendingDeletesRef.current[toastId]) {
      clearTimeout(pendingDeletesRef.current[toastId]);
      delete pendingDeletesRef.current[toastId];
    }
    
    setDeleteToasts(prev => prev.filter(t => t.id !== toastId));
    
    setHistoryFiles(prev => {
      const updated = [...prev, file];
      return updated.sort((a,b) => new Date(b.createdTime || 0).getTime() - new Date(a.createdTime || 0).getTime());
    });
  };

  const startRename = () => {
    setEditFileName(previewName);
    setIsRenaming(true);
  };

  const cancelRename = () => {
    setIsRenaming(false);
  };

  const confirmRename = async () => {
    if (!previewFileId || !editFileName || editFileName === previewName) {
      setIsRenaming(false);
      return;
    }

    const oldName = previewName;
    setPreviewName(editFileName);
    setIsRenaming(false);

    try {
      await renameFile(previewFileId, editFileName);
      setHistoryFiles(prev => prev.map(f => f.id === previewFileId ? { ...f, name: editFileName } : f));
    } catch (err) {
      console.error(err);
      setPreviewName(oldName);
      alert('Failed to rename file');
    }
  };

  useEffect(() => {
    // Physical button logic (simulate with Spacebar / Volume keys if device allows)
    const handleKeyDown = (e: KeyboardEvent) => {
      // Spacebar, VolumeUp, VolumeDown
      if (e.code === 'Space' || e.key === 'AudioVolumeUp' || e.key === 'AudioVolumeDown') {
        e.preventDefault();
        toggleRecording();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isRecording, isAuthenticated]);

  const handleLogin = async () => {
    setStatusText('Authenticating...');
    try {
      await initOAuth();
      setIsAuthenticated(true);
      setStatusText('readyToRecord');
    } catch (err: any) {
      setStatusText(`Auth Error: ${err.message}`);
    }
  };

  const toggleRecording = useCallback(() => {
    if (!isAuthenticated) return;
    if (isRecording) {
      stopRecording();
      // "再次按下该按键时，能够停止当前录制并直接开始一段新录制"
      // Based on prompt: start a new one immediately after stopping.
      // We wait a tiny bit to ensure previous recorder closed.
      setTimeout(() => startRecording(), 300);
    } else {
      startRecording();
    }
  }, [isRecording, isAuthenticated]);

  const startRecording = async () => {
    if (isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => handleStopRecording(audioChunksRef.current);

      mediaRecorder.start();
      startTimeRef.current = Date.now();
      setIsRecording(true);
      setStatusText('recording');
    } catch (err) {
      console.error('Mic error:', err);
      setStatusText('Microphone permission denied.');
    }
  };

  const stopRecordingAndFinish = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
      setIsRecording(false);
      setStatusText('analyzingAudio');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
      setIsRecording(false);
    }
  };

  const handleStopRecording = async (chunks: BlobPart[]) => {
    const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm';
    const audioBlob = new Blob(chunks, { type: mimeType });
    if (audioBlob.size < 1000) {
      setStatusText('recordingTooShort');
      return;
    }
    
    if (autoProcess) {
      await processAndUpload(audioBlob, mimeType);
    } else {
      setPendingAudio({ blob: audioBlob, mimeType });
      setStatusText('readyToRecord');
    }
  };

  const handleMerge = async () => {
    if (selectedFileIds.length < 2) return;
    
    setIsProcessing(true);
    setProcessingStatus('mergingDocs');
    setStatusText('mergingDocs');
    
    try {
      // Fetch contents of all selected docs
      const docsContent: string[] = [];
      for (const id of selectedFileIds) {
        let content = '';
        try {
          content = await exportDocAsText(id);
        } catch (e) {
          console.error("Failed to export doc content for", id, e);
        }
        if (content) {
          docsContent.push(content);
        }
      }

      const mergedRes = await mergeDocumentsWithGemini(docsContent, language);
      
      setProcessingStatus('savingToDrive');
      const safeTitle = mergedRes.title ? mergedRes.title.replace(/[\\/:*?"<>|]/g, '') : `Merged_${new Date().toISOString()}`;
      
      const currentFolderId = folderId || await getOrCreateFolder(folderName);
      if (!folderId) setFolderId(currentFolderId);
      const newDocFile = await createGoogleDoc(safeTitle, mergedRes.mergedContent, currentFolderId);
      
      // Merge was successful, now delete the old selected documents
      for (const id of selectedFileIds) {
        try {
          await deleteDriveFile(id);
        } catch(e) {
          console.error(`Failed to delete merged file ${id}`);
        }
      }

      setHistoryFiles(prev => {
        const filtered = prev.filter(f => !selectedFileIds.includes(f.id));
        const updated = [newDocFile, ...filtered];
        return updated.sort((a,b) => new Date(b.createdTime || 0).getTime() - new Date(a.createdTime || 0).getTime());
      });

      setProcessingStatus('processComplete');
      setSelectedFileIds([]);
      setIsSelecting(false);
      
      // Clear status after short delay
      setTimeout(() => {
        setProcessingStatus('');
        setIsProcessing(false);
        setStatusText('readyToRecord');
      }, 3000);
      
      fetchLatestFilesSilently();
    } catch (e: any) {
      console.error(e);
      setProcessingStatus(`Error: ${e.message || renderText('processingFailed')}`);
      setTimeout(() => {
        setProcessingStatus('');
        setIsProcessing(false);
        setStatusText('readyToRecord');
      }, 5000);
    }
  };

  const handleLocalUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setProcessingStatus('processingUpload');
    
    try {
      await processAndUpload(file, file.type);
    } catch (err) {
      console.error(err);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const processAndUpload = async (audioBlob: Blob, mimeType: string) => {
    setIsProcessing(true);
    setProcessingStatus('analyzingAudio');
    setPendingAudio(null);

    try {
      let location: {lat: number, lng: number} | undefined;
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) => 
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3000 })
        );
        location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch (e) {
        console.warn('Location ignored or timed out');
      }

      // Convert to base64 efficiently using FileReader
      const base64Audio = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(audioBlob);
      });

      setProcessingStatus('connectingToDrive');
      const currentFolderId = folderId || await getOrCreateFolder(folderName);
      if (!folderId) setFolderId(currentFolderId);

      // 1. Process with Gemini
      setProcessingStatus('analyzingAudio');
      const aiResult = await processAudioWithGemini(base64Audio, mimeType, lastSummary, location, language);
      setProcessingStatus('savingToDrive');

      // 2. Upload to Drive
      const safeTitle = aiResult.title ? aiResult.title.replace(/[\\/:*?"<>|]/g, '') : `Memo_${new Date().toISOString()}`;
      const filename = `${safeTitle}.webm`;
      const uploadedFile = await uploadToDrive(base64Audio, mimeType, filename, currentFolderId);

      setProcessingStatus('updatingDocs');
      // 3. Save to Google Doc
      const docContent = `Time: ${new Date().toLocaleString()}\nLocation: ${location ? `${location.lat}, ${location.lng}` : 'Unknown'}\n\nTranscript:\n${aiResult.transcript}\n\nSummary:\n${aiResult.summary}`;
      
      let currentDocId = lastDocId;
      let newDocFile: DriveFile | null = null;
      if (aiResult.action === 'merge' && lastDocId) {
        await appendToGoogleDoc(lastDocId, docContent);
      } else {
        newDocFile = await createGoogleDoc(safeTitle, docContent, currentFolderId);
        currentDocId = newDocFile.id;
        setLastDocId(currentDocId);
      }
      
      setLastSummary(aiResult.summary);

      // Optimistically add to UI
      setHistoryFiles(prev => {
        const additions = [uploadedFile];
        if (newDocFile) additions.push(newDocFile);
        const filtered = prev.filter(f => !additions.find(a => a.id === f.id));
        const updated = [...additions, ...filtered];
        return updated.sort((a,b) => new Date(b.createdTime || 0).getTime() - new Date(a.createdTime || 0).getTime());
      });

      setProcessingStatus('processComplete');
      
      // Clear status after short delay
      setTimeout(() => {
        setProcessingStatus('');
        setIsProcessing(false);
        setStatusText('readyToRecord');
      }, 3000);
      
      fetchLatestFilesSilently();
    } catch (err: any) {
      console.error(err);
      setProcessingStatus(`Error: ${err.message || renderText('processingFailed')}`);
      setTimeout(() => {
        setProcessingStatus('');
        setIsProcessing(false);
        setStatusText('readyToRecord');
      }, 5000);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-white text-zinc-900 font-sans flex flex-col items-center justify-center p-6">
        {/* Language switch */}
        <div className="absolute top-6 right-8 z-50">
          <button 
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-zinc-200 bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-600 transition-colors shadow-sm"
          >
            <Globe className="w-3.5 h-3.5" />
            {language === 'zh' ? 'EN' : '中'}
          </button>
        </div>

        <div className="max-w-md w-full space-y-8 text-center pt-10">
          <FileAudio className="w-16 h-16 mx-auto text-zinc-300" />
          <h1 className="text-3xl font-light tracking-tight text-zinc-950">{renderText('title')}</h1>
          <p className="text-zinc-500 text-sm">
            {renderText('signInDesc')}
          </p>
          
          <button 
            onClick={handleLogin}
            className="w-full flex items-center justify-center gap-3 bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl py-4 px-6 transition-all duration-200"
          >
            <LogIn className="w-5 h-5" />
            {renderText('signInBtn')}
          </button>

        </div>
      </div>
    );
  }

  return (
    <div 
      className="fixed inset-0 overflow-hidden bg-[#fafafa] text-zinc-900 font-sans flex flex-col select-none"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      {/* Top Floating Action Bar */}
      <div className="absolute top-6 left-5 right-5 z-30 pointer-events-none flex justify-between gap-3">
        {/* Tab Switcher */}
        <div className="pointer-events-auto flex items-center bg-white rounded-full p-1 border border-zinc-100 shadow-sm shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setActiveTab('audio'); setIsSelecting(false); setSelectedFileIds([]); }}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold tracking-wide transition-colors ${
              activeTab === 'audio' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            {renderText('tabAudio')}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setActiveTab('document'); setIsSelecting(false); setSelectedFileIds([]); }}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold tracking-wide transition-colors ${
              activeTab === 'document' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            {renderText('tabDoc')}
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Multi-Select Toggle */}
          {activeTab === 'document' && historyFiles.filter(f => !f.mimeType.includes('audio')).length > 1 && (
            <button
              onClick={(e) => { 
                e.stopPropagation(); 
                setIsSelecting(!isSelecting); 
                setSelectedFileIds([]); 
              }}
              className={`pointer-events-auto shrink-0 flex items-center justify-center w-10 h-10 rounded-full shadow-sm border transition-all ${
                isSelecting ? 'bg-[#f4f4f5] border-zinc-300 text-zinc-900' : 'bg-white border-zinc-100 text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              {isSelecting ? <X className="w-5 h-5" /> : <ListChecks className="w-5 h-5" />}
            </button>
          )}

          {/* Language Toggle */}
          <button 
            onClick={(e) => { e.stopPropagation(); setLanguage(language === 'zh' ? 'en' : 'zh'); }}
            className="pointer-events-auto shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-white shadow-sm border border-zinc-100 hover:bg-zinc-50 text-sm font-bold tracking-wider text-zinc-700 transition-all font-mono"
          >
            {language === 'zh' ? 'EN' : '中'}
          </button>
        </div>
      </div>

      <div className="flex-1 w-full pt-28 pb-40 px-5 flex flex-col min-h-0 relative z-10 transition-all duration-300">
        <div className="flex-1 overflow-y-auto w-full max-w-md mx-auto no-scrollbar space-y-3 pb-4 pr-1">
          <AnimatePresence mode="popLayout" initial={false}>
          {historyFiles.filter(file => activeTab === 'audio' ? file.mimeType.includes('audio') : !file.mimeType.includes('audio')).length === 0 ? null : (
            historyFiles
              .filter(file => activeTab === 'audio' ? file.mimeType.includes('audio') : !file.mimeType.includes('audio'))
              .map(file => (
              <motion.button
                key={file.id}
                layout
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -10, transition: { duration: 0.2 } }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className={`relative w-full flex items-center gap-4 p-4 pr-3 rounded-3xl transition-all text-left shadow-sm border overflow-hidden ${
                  isSelecting && selectedFileIds.includes(file.id) ? 'bg-blue-50 border-blue-200' : 'bg-white hover:bg-zinc-50 border-zinc-100/80'
                } ${playingFileId === file.id ? 'border-blue-500/50 shadow-blue-500/10' : ''}`}
                onClick={(e) => openPreview(file, e)}
              >
                {isSelecting && activeTab === 'document' && (
                  <div className={`shrink-0 flex items-center justify-center w-6 h-6 rounded-full border transition-colors ${selectedFileIds.includes(file.id) ? 'bg-blue-500 border-blue-500 text-white' : 'border-zinc-300'}`}>
                    {selectedFileIds.includes(file.id) && <CheckCircle2 className="w-4 h-4" />}
                  </div>
                )}
                <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-colors ${isSelecting && selectedFileIds.includes(file.id) ? 'bg-blue-100 border border-blue-200' : 'bg-zinc-50 border border-zinc-100'}`}>
                  {file.mimeType.includes('audio') ? (
                    <div className="relative">
                      <FileAudio className="w-5 h-5 text-zinc-400" />
                      {playingFileId === file.id && (
                        <span className="flex absolute -top-1 -right-1">
                           <span className="animate-ping absolute inline-flex h-2.5 w-2.5 rounded-full bg-blue-400 opacity-75"></span>
                           <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
                        </span>
                      )}
                    </div>
                  ) : (
                    <FileText className="w-5 h-5 text-blue-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0 pr-2">
                  <p className="font-semibold text-zinc-800 truncate text-[15px] leading-snug">{file.name}</p>
                  <p className="text-[13px] text-zinc-400 font-medium pt-1">
                    {file.createdTime ? new Date(file.createdTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </p>
                </div>
                {!isSelecting && (
                  <div className="flex items-center gap-1 shrink-0">
                    <div 
                      onClick={(e) => handleDelete(file, e)}
                      className="p-3 text-zinc-300 hover:text-red-500 transition-colors flex items-center justify-center active:scale-95"
                    >
                      <Trash2 className="w-5 h-5 outline-none hover:fill-current" strokeWidth={2} />
                    </div>
                    {file.mimeType.includes('audio') && (
                      <div 
                        onClick={(e) => togglePlay(file, e)}
                        className="p-3 text-zinc-300 hover:text-blue-500 transition-colors flex items-center justify-center active:scale-95"
                      >
                        {playingFileId === file.id ? <Square className="w-6 h-6 fill-current text-blue-500" /> : <Play className="w-6 h-6 outline-none hover:fill-current" strokeWidth={2.5} />}
                      </div>
                    )}
                  </div>
                )}
              </motion.button>
            ))
          )}
          </AnimatePresence>
        </div>
      </div>

      <div className="absolute bottom-6 pb-safe w-full flex flex-col items-center z-40 px-6 gap-5 pointer-events-none">
        {/* Processing State */}
        <div className={`transition-all duration-300 pointer-events-auto ${
          isProcessing || isRecording ? 'opacity-100 translate-y-0 h-auto' : 'opacity-0 translate-y-2 h-0 overflow-hidden'
        }`}>
          {isProcessing ? (
            <div className="flex items-center gap-3 px-5 py-2.5 rounded-full border border-zinc-200 bg-white shadow-sm text-sm font-medium text-zinc-600">
              {processingStatus === 'processComplete' ? (
                <CheckCircle2 className="w-4 h-4 text-green-500" />
              ) : (
                <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
              )}
              <span className="tracking-wide">{processingStatus.startsWith('Error') ? processingStatus : renderText(processingStatus || statusText)}</span>
            </div>
          ) : isRecording ? (
            <div className="flex items-center gap-2 text-sm font-bold text-red-500 tracking-widest px-5 py-2.5">
              {renderText('recording')}
              <span className="flex flex-col gap-1 -mt-1 relative">
                <span className="w-1 h-1 bg-red-500 rounded-full animate-ping absolute"></span>
                <span className="w-1 h-1 bg-red-500 rounded-full"></span>
              </span>
            </div>
          ) : null}
        </div>

        {/* Bottom Control Bar */}
        <div className="pointer-events-auto flex items-center justify-center gap-6 w-full max-w-sm">
          {/* Drive Link */}
          {folderId && (
            <a 
              href={`https://drive.google.com/drive/folders/${folderId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-14 h-14 rounded-full flex items-center justify-center bg-white shadow-md border border-zinc-100 hover:bg-zinc-50 transition-all outline-none text-zinc-900"
              title="Open Google Drive"
            >
              <DriveIcon className="w-7 h-7" />
            </a>
          )}

          {/* Action Button (Record or Merge) */}
          {isSelecting ? (
            <button
              onClick={(e) => { e.stopPropagation(); handleMerge(); }}
              disabled={selectedFileIds.length < 2 || isProcessing}
              className="shrink-0 flex items-center justify-center gap-2 w-full max-w-[200px] h-14 rounded-full bg-zinc-900 text-white hover:bg-zinc-800 transition-all font-semibold disabled:opacity-50 disabled:bg-zinc-300 shadow-lg"
            >
              <Combine className="w-5 h-5" />
              {selectedFileIds.length < 2 ? renderText('selectDocsToMerge') : `${renderText('mergeSelected')} (${selectedFileIds.length})`}
            </button>
          ) : (
            <button 
              onClick={(e) => { e.stopPropagation(); toggleRecording(); }}
              disabled={isProcessing}
              className={`shrink-0 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 outline-none shadow-xl
                ${isRecording 
                  ? 'bg-red-500 text-white hover:bg-red-600 scale-110 shadow-red-500/30' 
                  : 'bg-zinc-900 text-white hover:bg-zinc-800 hover:scale-105'
                }
                disabled:opacity-50 disabled:scale-100
              `}
            >
              {isRecording ? <Square className="w-8 h-8 fill-current" /> : <Mic className="w-8 h-8" />}
            </button>
          )}

          {/* Upload Button */}
          {!isSelecting && !isProcessing && !isRecording && (
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="w-14 h-14 rounded-full flex items-center justify-center bg-white shadow-md border border-zinc-100 hover:bg-zinc-50 transition-all outline-none"
            >
              <Upload className="w-6 h-6 text-zinc-600" />
            </button>
          )}
        </div>
      </div>

      <input 
        type="file" 
        accept="audio/*" 
        className="hidden" 
        ref={fileInputRef}
        onChange={handleLocalUpload}
      />

      {/* Manual Review UI */}
      {pendingAudio && !isProcessing && (
        <div className="absolute inset-0 bg-white z-50 flex flex-col items-center justify-between p-6 pt-24 pb-12">
          <div className="flex flex-col items-center gap-8 w-full max-w-sm">
            <h2 className="text-2xl font-light text-zinc-900 tracking-tight text-center">{renderText('reviewRecording')}</h2>
            <audio controls src={URL.createObjectURL(pendingAudio.blob)} className="w-full rounded-[24px] shadow-sm border border-zinc-100" />
          </div>
          <div className="flex flex-col gap-4 w-full max-w-xs mt-auto">
            <button
              onClick={() => processAndUpload(pendingAudio.blob, pendingAudio.mimeType)}
              className="w-full py-4 rounded-full text-base font-semibold text-white bg-zinc-900 hover:bg-zinc-800 transition-all shadow-md active:scale-[0.98]"
            >
              {renderText('processAndUpload')}
            </button>
            <button
              onClick={() => setPendingAudio(null)}
              className="w-full py-4 rounded-full text-base font-semibold text-zinc-500 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 transition-all active:scale-[0.98]"
            >
              {renderText('discard')}
            </button>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewUrl && (
        <div className="absolute inset-0 bg-[#fafafa] z-[70] flex flex-col pointer-events-auto pb-safe">
          <div className="flex items-center justify-between p-4 pt-12 border-b border-zinc-100/50 flex-shrink-0 bg-white">
            <div className="flex-1 min-w-0 px-4">
              {isRenaming ? (
                <div className="flex items-center gap-3 w-full animate-in fade-in slide-in-from-left-2 duration-200">
                  <input
                    autoFocus
                    type="text"
                    value={editFileName}
                    onChange={(e) => setEditFileName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
                    className="flex-1 bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-zinc-900/10 focus:border-zinc-400 transition-all"
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <button 
                      onClick={confirmRename}
                      className="h-10 px-4 bg-zinc-900 text-white rounded-xl text-xs font-bold hover:bg-zinc-800 active:scale-95 transition-all flex items-center justify-center"
                    >
                      {renderText('save')}
                    </button>
                    <button 
                      onClick={cancelRename}
                      className="h-10 px-4 bg-zinc-100 text-zinc-600 rounded-xl text-xs font-bold hover:bg-zinc-200 active:scale-95 transition-all flex items-center justify-center"
                    >
                      {renderText('cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 group cursor-pointer" onClick={startRename}>
                  <h2 className="text-lg font-semibold text-zinc-900 tracking-tight truncate">{previewName}</h2>
                  <button className="text-zinc-300 group-hover:text-zinc-500 transition-colors">
                    <Pencil className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100" />
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 w-full bg-zinc-50 relative">
            <iframe 
              src={previewUrl} 
              className="w-full h-full border-none absolute inset-0 bg-transparent"
              allow="autoplay"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            ></iframe>
          </div>
          <div className="p-6 pb-6 pt-4 flex justify-center flex-shrink-0 bg-white border-t border-zinc-100/50 shadow-[0_-4px_24px_rgba(0,0,0,0.02)]">
            <button 
              onClick={(e) => { e.stopPropagation(); setPreviewUrl(null); }}
              className="w-16 h-16 bg-white border border-zinc-200 text-zinc-600 rounded-full flex items-center justify-center hover:bg-zinc-50 transition-all shadow-md hover:scale-105 active:scale-95"
            >
              <X className="w-8 h-8" strokeWidth={2} />
            </button>
          </div>
        </div>
      )}

      {/* Undo Toasts */}
      <div className="absolute bottom-36 left-0 right-0 z-[80] pointer-events-none flex flex-col items-center gap-2 px-5 pb-safe">
        <AnimatePresence>
          {deleteToasts.map(toast => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
              className="pointer-events-auto flex items-center justify-between w-full max-w-sm bg-zinc-900 text-white px-5 py-3.5 rounded-2xl shadow-xl shadow-zinc-900/20"
            >
              <span className="text-[15px] font-medium truncate pr-4 text-zinc-100">
                {renderText('deleted')}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  undoDelete(toast.id, toast.file);
                }}
                className="shrink-0 text-blue-400 font-bold tracking-wide text-[15px] hover:text-blue-300 transition-colors uppercase"
              >
                {renderText('undo')}
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

    </div>
  );
}