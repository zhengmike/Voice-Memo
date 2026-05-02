import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Square, Loader2, FileAudio, LogIn, LogOut, Globe, History, X, FileText, Play, Pause, Trash2, CheckCircle2, ListChecks, Combine, ExternalLink, FolderOpen, Upload, Pencil } from 'lucide-react';
import { initOAuth, uploadToDrive, createGoogleDoc, appendToGoogleDoc, getTodaysFiles, DriveFile, getToken, deleteDriveFile, exportDocAsText, exportDocAsHtml, updateGoogleDocContent, getOrCreateFolder, updateFileMetadata, checkExistingAuth, logout, getUserInfo, GoogleUserInfo } from './services/googleService';
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
  const [userInfo, setUserInfo] = useState<GoogleUserInfo | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [statusText, setStatusText] = useState('readyToRecord');
  const [lastDocId, setLastDocId] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string>('');

  const autoProcess = true;
  const [pendingAudio, setPendingAudio] = useState<{blob: Blob, mimeType: string, recordedDurationMs?: number} | null>(null);

  const folderName = 'Voice Memos';
  const [folderId, setFolderId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const startTimeRef = useRef<number>(0);

  const [historyFiles, setHistoryFiles] = useState<DriveFile[]>([]);
  const [activeTab, setActiveTab] = useState<'audio' | 'document'>('audio');
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>('');
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [previewMimeType, setPreviewMimeType] = useState<string>('');
  const [previewHtmlContent, setPreviewHtmlContent] = useState<string | null>(null);
  const [isEditingDoc, setIsEditingDoc] = useState(false);
  const [isSavingDoc, setIsSavingDoc] = useState(false);
  const editorIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [editFileName, setEditFileName] = useState('');
  
  const [playingFileId, setPlayingFileId] = useState<string | null>(null);
  const playAudioRef = useRef<HTMLAudioElement | null>(null);

  const [deleteToasts, setDeleteToasts] = useState<{id: string, file: DriveFile}[]>([]);
  const pendingDeletesRef = useRef<Record<string, NodeJS.Timeout>>({});
  
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  useEffect(() => {
    if (checkExistingAuth()) {
      setIsAuthenticated(true);
      getUserInfo().then(setUserInfo).catch(console.error);
    }
  }, []);

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

  const openPreview = async (file: DriveFile, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    let url = file.webViewLink || '';
    if (url.includes('/view')) {
      url = url.replace('/view', '/preview');
    } else if (url.includes('/edit')) {
      url = url.replace('/edit', '/preview');
    }
    
    setPreviewName(file.name);
    setPreviewUrl(url);
    setPreviewFileId(file.id);
    setPreviewMimeType(file.mimeType);
    setPreviewHtmlContent(null);
    setIsEditingDoc(false);
    setIsRenaming(false);
    
    // Pre-load HTML for Google Docs to enable editing
    if (file.mimeType === 'application/vnd.google-apps.document') {
      try {
        const htmlContent = await exportDocAsHtml(file.id);
        setPreviewHtmlContent(htmlContent);
      } catch (err) {
        console.error('Failed to preload doc HTML:', err);
      }
    }
  };

  const saveDocContent = async () => {
    if (!previewFileId) return;
    setIsSavingDoc(true);
    try {
      let finalHtml = previewHtmlContent || '';
      if (editorIframeRef.current?.contentDocument) {
        finalHtml = editorIframeRef.current.contentDocument.documentElement.outerHTML;
      }
      
      await updateGoogleDocContent(previewFileId, finalHtml);
      setIsEditingDoc(false);
      setPreviewHtmlContent(finalHtml); // update state
      // Reload the preview URL so the preview iframe updates
      setPreviewUrl(prev => prev ? prev + '&t=' + Date.now() : prev);
    } catch (err) {
      console.error(err);
      alert('Failed to save document changes');
    } finally {
      setIsSavingDoc(false);
    }
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
        if (file.id.startsWith('local-')) {
           // Local mock playback
           const audio = new Audio(file.webViewLink);
           audio.onended = () => {
             if (playAudioRef.current === audio) setPlayingFileId(null);
           };
           const playPromise = audio.play();
           if (playPromise !== undefined) {
             playPromise.catch((err: any) => {
               if (err.name !== 'AbortError' && !err.message?.includes('interrupted')) {
                 console.error("Local playback error", err);
               }
               if (playAudioRef.current === audio) {
                 setPlayingFileId(null);
               }
             });
           }
           playAudioRef.current = audio;
           return;
        }

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
      await updateFileMetadata(previewFileId, { name: editFileName });
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
      const info = await getUserInfo();
      setUserInfo(info);
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
    let recordedDurationMs = 0;
    if (startTimeRef.current > 0) {
      recordedDurationMs = Date.now() - startTimeRef.current;
      startTimeRef.current = 0;
    }

    const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm';
    const audioBlob = new Blob(chunks, { type: mimeType });
    if (audioBlob.size < 1000) {
      setStatusText('recordingTooShort');
      return;
    }
    
    if (autoProcess) {
      await processAndUpload(audioBlob, mimeType, recordedDurationMs);
    } else {
      setPendingAudio({ blob: audioBlob, mimeType, recordedDurationMs });
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

  const processAndUpload = async (audioBlob: Blob, mimeType: string, recordedDurationMs?: number) => {
    setIsProcessing(true);
    setPendingAudio(null);

    const tempId = `local-${Date.now()}`;
    const blobUrl = URL.createObjectURL(audioBlob);
    
    // 1. Initial Local Visibility
    setProcessingStatus('analyzingAudio');
    
    try {
      // Calculate duration
      let durationStr = '';
      if (typeof recordedDurationMs === 'number' && recordedDurationMs > 0) {
        const min = Math.floor(recordedDurationMs / 60000);
        const sec = Math.floor((recordedDurationMs % 60000) / 1000);
        durationStr = `${min}:${sec.toString().padStart(2, '0')}`;
      } else {
        durationStr = await new Promise<string>((resolve) => {
          const audio = new Audio();
          audio.src = blobUrl;
          audio.addEventListener('loadedmetadata', () => {
            let calcDuration = audio.duration;
            if (calcDuration === Infinity || isNaN(calcDuration)) {
               resolve('');
               return;
            }
            const min = Math.floor(calcDuration / 60);
            const sec = Math.floor(calcDuration % 60);
            resolve(`${min}:${sec.toString().padStart(2, '0')}`);
          });
          audio.addEventListener('error', () => {
            resolve('');
          });
        });
      }
      const audioDuration = durationStr;

      // Add mock file to history immediately
      const mockAudioFile: DriveFile = {
        id: tempId,
        name: `Recording ${new Date().toLocaleTimeString()}`,
        mimeType: mimeType,
        createdTime: new Date().toISOString(),
        webViewLink: blobUrl, // Local playback link
        description: JSON.stringify({ duration: audioDuration, status: 'uploading' })
      };

      setHistoryFiles(prev => [mockAudioFile, ...prev]);
      setActiveTab('audio'); // Switch to audio tab to see the recording

      // Convert to base64 efficiently using FileReader (needed for both Drive upload and Gemini)
      const base64Audio = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(audioBlob);
      });

      // 2. Upload to Drive First
      setProcessingStatus('connectingToDrive');
      let currentFolderId = folderId || await getOrCreateFolder(folderName);
      if (!folderId) setFolderId(currentFolderId);

      setProcessingStatus('savingToDrive');
      const filename = `Memo_${new Date().toISOString()}.webm`;
      const encodedDescription = JSON.stringify({ duration: audioDuration, status: 'processing' });
      
      let uploadedFile: DriveFile | null = null;
      try {
        uploadedFile = await uploadToDrive(base64Audio, mimeType, filename, currentFolderId, encodedDescription);
      } catch (uploadErr: any) {
        if (uploadErr.message?.includes('File not found')) {
          setFolderId(null);
          currentFolderId = await getOrCreateFolder(folderName);
          setFolderId(currentFolderId);
          uploadedFile = await uploadToDrive(base64Audio, mimeType, filename, currentFolderId, encodedDescription);
        } else {
          throw uploadErr;
        }
      }

      // Update history: Replace mock with uploaded file (now it has a real Drive ID)
      setHistoryFiles(prev => prev.map(f => f.id === tempId ? uploadedFile! : f));

      // 3. Process with Gemini
      setProcessingStatus('analyzingAudio');
      const aiResult = await processAudioWithGemini(base64Audio, mimeType, lastSummary, language);

      // Update file metadata on Drive (name, and remove 'processing' status)
      try {
        const newMetadata: any = { description: JSON.stringify({ duration: audioDuration }) };
        let finalTitle = uploadedFile!.name;
        
        if (aiResult.title && !aiResult.isSilent) {
          finalTitle = `${aiResult.title.replace(/[\\/:*?"<>|]/g, '')}.webm`;
          newMetadata.name = finalTitle;
        }

        await updateFileMetadata(uploadedFile!.id, newMetadata);
        uploadedFile = { ...uploadedFile!, name: finalTitle, description: newMetadata.description };
        setHistoryFiles(prev => prev.map(f => f.id === uploadedFile!.id ? uploadedFile! : f));
      } catch (metadataErr) {
        console.error("Metadata update failed", metadataErr);
      }

      // 4. Create Doc if not silent
      if (aiResult.isSilent) {
        setProcessingStatus('processComplete');
        setTimeout(() => {
          setProcessingStatus('');
          setIsProcessing(false);
          setStatusText('readyToRecord');
        }, 3000);
        fetchLatestFilesSilently();
        return;
      }

      setProcessingStatus('updatingDocs');
      const plainTextContent = `Time: ${new Date().toLocaleString()}\n\nTranscript:\n${aiResult.transcript}\n\nSummary:\n${aiResult.summary}`;
      const htmlContent = aiResult.docHtml ? `<div><p><strong>Time:</strong> ${new Date().toLocaleString()}</p></div>${aiResult.docHtml}` : plainTextContent;
      
      let currentDocId = lastDocId;
      let newDocFile: DriveFile | null = null;
      const safeDocTitle = aiResult.title ? aiResult.title.replace(/[\\/:*?"<>|]/g, '') : `Memo_${new Date().toISOString()}`;

      if (aiResult.action === 'merge' && lastDocId) {
        try {
          await appendToGoogleDoc(lastDocId, plainTextContent);
        } catch (appendErr: any) {
          if (appendErr.message?.includes('File not found') || appendErr.message?.includes('404')) {
             newDocFile = await createGoogleDoc(safeDocTitle, htmlContent, currentFolderId);
             currentDocId = newDocFile.id;
             setLastDocId(currentDocId);
          } else {
             throw appendErr;
          }
        }
      } else {
        newDocFile = await createGoogleDoc(safeDocTitle, htmlContent, currentFolderId);
        currentDocId = newDocFile.id;
        setLastDocId(currentDocId);
      }
      
      setLastSummary(aiResult.summary);

      // Add completed Doc to UI
      if (newDocFile) {
        setHistoryFiles(prev => {
          const updated = [newDocFile, ...prev];
          return updated.sort((a,b) => new Date(b.createdTime || 0).getTime() - new Date(a.createdTime || 0).getTime());
        });
      }

      setProcessingStatus('processComplete');
      setTimeout(() => {
        setProcessingStatus('');
        setIsProcessing(false);
        setStatusText('readyToRecord');
      }, 3000);
      
      fetchLatestFilesSilently();
    } catch (err: any) {
      console.error(err);
      setProcessingStatus(`Error: ${err.message || renderText('processingFailed')}`);
      
      // If it failed, remove mock if still exists and not uploaded
      setHistoryFiles(prev => prev.filter(f => f.id !== tempId));

      // If it uploaded but failed later, remove the analyzing status
      if (uploadedFile) {
        try {
          const fallbackMetadata: any = { description: JSON.stringify({ duration: audioDuration }) }; // no status
          await updateFileMetadata(uploadedFile.id, fallbackMetadata);
          setHistoryFiles(prev => prev.map(f => f.id === uploadedFile!.id ? { ...f, description: fallbackMetadata.description } : f));
        } catch(e) {
          console.error("Cleanup metadata failed", e);
        }
      }
      
      setTimeout(() => {
        setProcessingStatus('');
        setIsProcessing(false);
        setStatusText('readyToRecord');
      }, 5000);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="fixed inset-0 overflow-hidden bg-white text-zinc-900 font-sans flex flex-col items-center justify-center p-6">
        {/* Language switch hidden
        <div className="absolute top-6 right-8 z-50">
          <button 
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-zinc-200 bg-white hover:bg-zinc-50 text-xs font-medium text-zinc-600 transition-colors shadow-sm"
          >
            <Globe className="w-3.5 h-3.5" />
            {language === 'zh' ? 'EN' : '中'}
          </button>
        </div>
        */}

        <div className="max-w-md w-full space-y-8 text-center pt-10">
          <img src="/logo.svg" alt="拾音 Logo" className="h-24 mx-auto object-contain mb-8" />
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

  const displayedFiles = historyFiles.filter(file => activeTab === 'audio' ? file.mimeType.includes('audio') : !file.mimeType.includes('audio'));

  return (
    <div 
      className="fixed inset-0 overflow-hidden bg-[#fafafa] text-zinc-900 font-sans flex flex-col select-none"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      {/* User Menu Overlay */}
      {showUserMenu && (
        <div 
          className="absolute inset-0 z-20 pointer-events-auto" 
          onClick={(e) => { e.stopPropagation(); setShowUserMenu(false); }}
        />
      )}

      {/* Top Header */}
      <div className="absolute top-6 left-5 right-5 z-30 pointer-events-none flex justify-between items-center">
        {/* Logo and App Name */}
        <div className="flex items-center pointer-events-auto">
          <img src="/logo.svg" alt="拾音 Logo" className="h-10 object-contain ml-1" />
        </div>

        {/* User Avatar Action Bar */}
        <div className="flex items-center justify-end gap-3 relative">
          {userInfo && (
            <div className="relative">
              <button 
                onClick={(e) => { e.stopPropagation(); setShowUserMenu(!showUserMenu); }}
                className="pointer-events-auto shrink-0 flex items-center justify-center w-11 h-11 rounded-full bg-white shadow-sm border border-zinc-100 hover:border-zinc-200 hover:shadow-md transition-all overflow-hidden"
              >
                <img src={userInfo.picture} alt="Avatar" className="w-full h-full object-cover" />
              </button>

              <AnimatePresence>
                {showUserMenu && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute right-0 top-14 w-48 bg-white rounded-2xl shadow-xl border border-zinc-100 p-2 z-[100] origin-top-right flex flex-col pointer-events-auto"
                  >
                    <div className="p-3 border-b border-zinc-50 mb-2 truncate">
                      <p className="text-sm font-semibold text-zinc-900 truncate">{userInfo.name}</p>
                      <p className="text-xs text-zinc-500 truncate">{userInfo.email}</p>
                    </div>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowUserMenu(false);
                        setShowLogoutConfirm(true);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-red-600 font-medium hover:bg-red-50 rounded-xl transition-colors flex items-center gap-2"
                    >
                      <LogOut className="w-4 h-4" />
                      {renderText('logout')}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="absolute top-24 left-0 right-0 z-20 pointer-events-none flex justify-center">
        <div className="pointer-events-auto flex items-center bg-white/70 backdrop-blur-xl rounded-full p-1.5 border border-zinc-200/60 shadow-sm shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setActiveTab('audio'); setSelectedFileIds([]); }}
            className={`px-6 py-2 rounded-full text-[15px] font-semibold tracking-wide transition-all duration-300 ${
              activeTab === 'audio' ? 'bg-white text-zinc-900 shadow-sm border border-zinc-100' : 'text-zinc-400 hover:text-zinc-600 border border-transparent'
            }`}
          >
            {renderText('tabAudio')}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setActiveTab('document'); setSelectedFileIds([]); }}
            className={`px-6 py-2 rounded-full text-[15px] font-semibold tracking-wide transition-all duration-300 ${
              activeTab === 'document' ? 'bg-white text-zinc-900 shadow-sm border border-zinc-100' : 'text-zinc-400 hover:text-zinc-600 border border-transparent'
            }`}
          >
            {renderText('tabDoc')}
          </button>
        </div>
      </div>

      <div className="flex-1 w-full pt-44 pb-40 px-5 flex flex-col min-h-0 relative z-10 transition-all duration-300">
        <div 
          className="flex-1 overflow-y-auto w-full max-w-md mx-auto no-scrollbar flex flex-col pb-4 pr-1"
        >
          <AnimatePresence initial={false}>
            {displayedFiles.length === 0 ? (
              <motion.div
                key="empty-state"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                transition={{ duration: 0.3 }}
                className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-5 min-h-[360px] m-auto"
              >
                <div className="w-24 h-24 rounded-[32px] bg-gradient-to-b from-zinc-50 to-zinc-100/50 border border-zinc-200/50 shadow-sm flex items-center justify-center text-zinc-300 mx-auto relative mb-2">
                  <div className="absolute inset-0 bg-white/50 rounded-[32px] pointer-events-none" />
                  {activeTab === 'audio' ? <Mic className="w-10 h-10 relative z-10" /> : <FileText className="w-10 h-10 relative z-10" />}
                </div>
                <div className="flex flex-col gap-2 relative z-10">
                  <h3 className="text-[19px] font-semibold text-zinc-800 tracking-tight">
                    {activeTab === 'audio' ? (language === 'zh' ? '暂无录音' : 'No recordings') : (language === 'zh' ? '暂无文档' : 'No documents')}
                  </h3>
                  <p className="text-[15px] text-zinc-500 max-w-[260px] mx-auto leading-relaxed">
                    {activeTab === 'audio' 
                      ? (language === 'zh' ? '点击下方麦克风开始录制，或上传本地音频文件' : 'Tap the microphone below to start recording, or upload local audio files')
                      : (language === 'zh' ? '您可以在录音后生成文档记录，或上传已有文件' : 'You can generate documents after recording, or upload existing ones')}
                  </p>
                </div>
              </motion.div>
            ) : (
            displayedFiles
              .map(file => (
              <motion.div
                key={file.id}
                layout
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: 'auto', marginBottom: 12 }}
                exit={{ opacity: 0, height: 0, scale: 0.95, paddingBottom: 0, paddingTop: 0, marginBottom: 0, overflow: 'hidden', transition: { duration: 0.2 } }}
                transition={{ 
                  layout: { type: "spring", stiffness: 500, damping: 50, mass: 1 },
                  opacity: { duration: 0.2 },
                  height: { duration: 0.2 },
                  marginBottom: { duration: 0.2 }
                }}
                className={`w-full shrink-0`}
              >
                <div
                className={`relative w-full flex items-center gap-4 p-4 pr-3 rounded-[32px] transition-all text-left shadow-[0_2px_12px_rgba(0,0,0,0.03)] border overflow-hidden cursor-pointer ${
                  activeTab === 'document' && selectedFileIds.includes(file.id) ? 'bg-blue-50 border-blue-200' : 'bg-white border-zinc-100/80 shadow-sm hover:border-zinc-200 hover:shadow-md'
                } ${playingFileId === file.id ? 'border-blue-500/50' : ''}`}
                onClick={(e) => openPreview(file, e)}
              >
                {activeTab === 'document' && (
                  <div 
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setSelectedFileIds(prev => 
                        prev.includes(file.id) ? prev.filter(id => id !== file.id) : [...prev, file.id]
                      );
                    }}
                    className={`shrink-0 flex items-center justify-center w-6 h-6 rounded-full border transition-colors cursor-pointer ${selectedFileIds.includes(file.id) ? 'bg-blue-500 border-blue-500 text-white' : 'border-zinc-300 hover:border-zinc-400'}`}>
                    {selectedFileIds.includes(file.id) && <CheckCircle2 className="w-4 h-4" />}
                  </div>
                )}
                <div className={`w-[46px] h-[46px] rounded-[16px] flex flex-col items-center justify-center shrink-0 transition-colors ${activeTab === 'document' && selectedFileIds.includes(file.id) ? 'bg-blue-100/50 border border-blue-200/50' : 'bg-zinc-50 border border-zinc-100/60'}`}>
                  <span className={`text-[10px] font-semibold uppercase tracking-wider mb-[1px] ${activeTab === 'document' && selectedFileIds.includes(file.id) ? 'text-blue-500/80' : 'text-zinc-400'}`}>
                    {file.createdTime ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'short' }).format(new Date(file.createdTime)) : ''}
                  </span>
                  <span className={`text-[16px] font-bold leading-none ${activeTab === 'document' && selectedFileIds.includes(file.id) ? 'text-blue-600' : 'text-zinc-700'}`}>
                    {file.createdTime ? new Date(file.createdTime).getDate() : ''}
                  </span>
                </div>
                <div className="flex-1 min-w-0 pr-2">
                  <p className="font-semibold text-zinc-800 truncate text-[15px] leading-snug">{file.name}</p>
                  <p className="text-[13px] text-zinc-400 font-medium pt-1 flex items-center gap-1.5 min-h-[1.5rem] flex-wrap">
                    <span className="shrink-0">
                      {file.createdTime ? new Date(file.createdTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                    {file.id.startsWith('local-') && (
                      <>
                        <span className="opacity-30 shrink-0">•</span>
                        <span className="flex items-center gap-1 text-blue-500 font-semibold shrink-0 whitespace-nowrap">
                          <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                          {language === 'zh' ? '上传中...' : 'Uploading...'}
                        </span>
                      </>
                    )}
                    {(() => {
                      if (!file.mimeType.includes('audio')) return null;
                      
                      let durationStr = '';
                      let status = '';
                      let isStuck = false;
                      if (file.description) {
                        try {
                          const parsed = JSON.parse(file.description);
                          durationStr = parsed?.duration || '';
                          status = parsed?.status || '';
                          
                          if (status === 'processing' && file.createdTime) {
                            const ageMs = Date.now() - new Date(file.createdTime).getTime();
                            if (ageMs > 5 * 60 * 1000) {
                              isStuck = true;
                            }
                          }
                        } catch (e) {}
                      }
                      
                      return (
                        <>
                          {status === 'processing' && !isStuck && (
                            <>
                              <span className="opacity-30 shrink-0">•</span>
                              <span className="flex items-center gap-1 text-amber-500 font-semibold animate-pulse shrink-0 whitespace-nowrap">
                                <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                                {language === 'zh' ? '分析中...' : 'Analyzing...'}
                              </span>
                            </>
                          )}
                          {status === 'processing' && isStuck && (
                            <>
                              <span className="opacity-30 shrink-0">•</span>
                              <span className="flex items-center gap-1 text-red-400 font-semibold shrink-0 whitespace-nowrap">
                                {language === 'zh' ? '分析失败' : 'Analysis Failed'}
                              </span>
                            </>
                          )}
                          {durationStr && (
                            <>
                              <span className="opacity-30 shrink-0">•</span>
                              <span className="shrink-0">{durationStr}</span>
                            </>
                          )}
                        </>
                      );
                    })()}
                  </p>
                </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <div 
                      onClick={(e) => handleDelete(file, e)}
                      className="p-3 text-zinc-300 hover:text-red-500 hover:bg-red-50 rounded-full transition-all flex items-center justify-center active:scale-90 group/del"
                    >
                      <Trash2 className="w-5 h-5 group-hover/del:scale-110 transition-transform" strokeWidth={1.5} />
                    </div>
                    {file.mimeType.includes('audio') && (
                      <div 
                        onClick={(e) => togglePlay(file, e)}
                        className="p-3 text-zinc-300 hover:text-blue-500 hover:bg-blue-50 rounded-full transition-all flex items-center justify-center active:scale-90"
                      >
                        {playingFileId === file.id ? <Square className="w-6 h-6 fill-current text-blue-500" /> : <Play className="w-6 h-6 outline-none hover:fill-current" strokeWidth={2.5} />}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )))}
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
          {/* External Link / Export */}
          {!isRecording && selectedFileIds.length === 0 && !isProcessing && (
            <button 
              onClick={(e) => { e.stopPropagation(); if (folderId) window.open(`https://drive.google.com/drive/folders/${folderId}`, '_blank'); }}
              className="w-14 h-14 rounded-full flex items-center justify-center bg-white shadow-sm border border-zinc-100 hover:bg-zinc-50 transition-all outline-none text-zinc-600"
              title="Open Google Drive"
            >
              <ExternalLink className="w-6 h-6" strokeWidth={1.5} />
            </button>
          )}

          {/* Action Button (Record or Merge) */}
          {selectedFileIds.length > 0 ? (
            <>
              <button
                onClick={(e) => { 
                  e.stopPropagation(); 
                  setSelectedFileIds([]); 
                }}
                className="w-14 h-14 shrink-0 rounded-full flex items-center justify-center bg-white shadow-sm border border-zinc-100 hover:bg-zinc-50 transition-all outline-none text-zinc-600 hover:text-zinc-900 hover:shadow-md"
                title={language === 'zh' ? '取消选择' : 'Cancel'}
              >
                <X className="w-6 h-6" strokeWidth={2} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleMerge(); }}
                disabled={selectedFileIds.length < 2 || isProcessing}
                className="shrink-0 flex items-center justify-center gap-2 flex-1 max-w-[200px] h-14 rounded-full bg-zinc-900 text-white hover:bg-zinc-800 transition-all font-semibold disabled:opacity-50 disabled:bg-zinc-300 shadow-lg px-4"
              >
                <Combine className="w-5 h-5 shrink-0" />
                <span className="truncate text-[15px]">
                  {selectedFileIds.length < 2 
                    ? (language === 'zh' ? '选择文档以合并' : 'Merge Docs')
                    : `${renderText('mergeSelected')} (${selectedFileIds.length})`
                  }
                </span>
              </button>
            </>
          ) : (
            <button 
              onClick={(e) => { e.stopPropagation(); toggleRecording(); }}
              disabled={isProcessing}
              className={`shrink-0 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 outline-none shadow-xl
                ${isRecording 
                  ? 'bg-red-500 text-white hover:bg-red-600 scale-110 shadow-red-500/30' 
                  : 'bg-[#18181b] text-white hover:bg-zinc-800 hover:scale-[1.02]'
                }
                disabled:opacity-50 disabled:scale-100
              `}
            >
              {isRecording ? <Square className="w-8 h-8 fill-current text-white" /> : <Mic className="w-8 h-8 text-white" strokeWidth={1.5} />}
            </button>
          )}

          {/* Upload Button */}
          {selectedFileIds.length === 0 && !isProcessing && !isRecording && (
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="w-14 h-14 rounded-full flex items-center justify-center bg-white shadow-sm border border-zinc-100 hover:bg-zinc-50 transition-all outline-none"
            >
              <Upload className="w-6 h-6 text-zinc-600" strokeWidth={1.5} />
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
              onClick={() => processAndUpload(pendingAudio.blob, pendingAudio.mimeType, pendingAudio.recordedDurationMs)}
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
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 group cursor-pointer overflow-hidden" onClick={startRename}>
                    <h2 className="text-lg font-semibold text-zinc-900 tracking-tight truncate">{previewName}</h2>
                    <button className="text-zinc-300 group-hover:text-zinc-500 transition-colors flex-shrink-0">
                      <Pencil className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100" />
                    </button>
                  </div>
                  {previewMimeType === 'application/vnd.google-apps.document' && previewHtmlContent !== null && (
                    <div className="flex-shrink-0">
                      {isEditingDoc ? (
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={saveDocContent}
                            disabled={isSavingDoc}
                            className="h-8 px-4 bg-zinc-900 text-white rounded-lg text-xs font-bold hover:bg-zinc-800 transition-all disabled:opacity-50 flex items-center gap-1"
                          >
                            {isSavingDoc && <Loader2 className="w-3 h-3 animate-spin"/>}
                            保存
                          </button>
                          <button 
                            onClick={() => setIsEditingDoc(false)}
                            disabled={isSavingDoc}
                            className="h-8 px-4 bg-zinc-100 text-zinc-600 rounded-lg text-xs font-bold hover:bg-zinc-200 transition-all disabled:opacity-50"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <button 
                          onClick={() => setIsEditingDoc(true)}
                          className="h-8 px-4 bg-blue-50 text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-100 transition-all"
                        >
                          编辑
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 w-full bg-zinc-50 relative">
            {isEditingDoc ? (
              <iframe
                ref={editorIframeRef}
                className="w-full h-full bg-white border-none focus:outline-none"
                onLoad={(e) => {
                  const iframe = e.currentTarget;
                  if (iframe.contentDocument) {
                    iframe.contentDocument.open();
                    iframe.contentDocument.write(previewHtmlContent || '');
                    iframe.contentDocument.close();
                    iframe.contentDocument.designMode = 'on';
                    // Disable margin on body to match preview
                    iframe.contentDocument.body.style.margin = '0 auto';
                    iframe.contentDocument.body.style.padding = '16px';
                    iframe.contentDocument.body.style.maxWidth = '800px';
                    iframe.contentDocument.body.style.boxSizing = 'border-box';
                    iframe.contentDocument.body.style.fontFamily = 'Inter, ui-sans-serif, system-ui, sans-serif';
                    // Override Google Docs default class padding if present
                    const style = iframe.contentDocument.createElement('style');
                    style.innerHTML = `
                      body { padding: 16px !important; margin: 0 auto !important; }
                      * { box-sizing: border-box; max-width: 100%; word-wrap: break-word; }
                      p, h1, h2, h3, h4, h5, h6, ul, ol, li, table { max-width: 100%; }
                    `;
                    iframe.contentDocument.head.appendChild(style);
                  }
                }}
              />
            ) : (
              <iframe 
                src={previewUrl} 
                className="w-full h-full border-none absolute inset-0 bg-transparent"
                allow="autoplay"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              />
            )}
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

      {/* Logout Confirm Modal */}
      <AnimatePresence>
        {showLogoutConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto px-4"
            onClick={() => setShowLogoutConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-[32px] p-6 w-full max-w-sm shadow-xl flex flex-col gap-6"
            >
              <h3 className="text-xl font-semibold text-zinc-800 text-center">
                {language === 'zh' ? '确定要退出登录吗？' : 'Are you sure you want to log out?'}
              </h3>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowLogoutConfirm(false)}
                  className="flex-1 py-3 px-4 rounded-2xl bg-zinc-100 text-zinc-600 font-medium hover:bg-zinc-200 transition-colors"
                >
                  {renderText('cancel')}
                </button>
                <button
                  onClick={() => {
                    logout();
                    setIsAuthenticated(false);
                    setUserInfo(null);
                    setHistoryFiles([]);
                    setShowLogoutConfirm(false);
                  }}
                  className="flex-1 py-3 px-4 rounded-2xl bg-red-500 text-white font-medium hover:bg-red-600 transition-colors"
                >
                  {language === 'zh' ? '继续退出' : 'Log out'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}