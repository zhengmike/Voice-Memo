const CLIENT_ID = (import.meta as any).env.VITE_GOOGLE_CLIENT_ID;

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.send'
].join(' ');

let currentToken = '';

declare const google: any;

export const initOAuth = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    try {
      if (!CLIENT_ID) {
        reject(new Error("VITE_GOOGLE_CLIENT_ID 环境变量未设置。"));
        return;
      }
      
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (response: any) => {
          if (response.access_token) {
            currentToken = response.access_token;
            resolve(response.access_token);
          } else {
            reject(new Error('Failed to get access token: ' + (response.error || 'Unknown error')));
          }
        },
      });
      client.requestAccessToken();
    } catch (error) {
      reject(error);
    }
  });
};

export const getToken = () => currentToken;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime?: string;
  webViewLink?: string;
}

export const getTodaysFiles = async (folderName: string): Promise<DriveFile[]> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  // First, get the folder ID
  const folderQuery = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${folderQuery}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const searchData = await searchRes.json();
  
  if (!searchData.files || searchData.files.length === 0) {
    return [];
  }
  const folderId = searchData.files[0].id;

  // Query all files in the folder, ordered by date descending
  const filesQuery = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const filesRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${filesQuery}&fields=files(id,name,mimeType,createdTime,webViewLink)&orderBy=createdTime desc&pageSize=50`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  const filesData = await filesRes.json();
  return filesData.files || [];
};

export const getOrCreateFolder = async (folderName: string): Promise<string> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  // Search for folder
  const query = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const searchData = await searchRes.json();
  
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id; // Return first match
  }

  // Create folder if not found
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(createData.error?.message || 'Failed to create folder');
  return createData.id;
};

export const uploadToDrive = async (base64Audio: string, mimeType: string, filename: string, folderId?: string): Promise<DriveFile> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  // base64 to Blob
  const byteString = atob(base64Audio);
  const u8arr = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    u8arr[i] = byteString.charCodeAt(i);
  }
  const file = new Blob([u8arr], { type: mimeType });

  const metadata: any = {
    name: filename,
    mimeType: mimeType
  };
  
  if (folderId) {
    metadata.parents = [folderId];
  }

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', file);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,createdTime,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Drive upload failed');
  return data as DriveFile; // Return full DriveFile
};

export const createGoogleDoc = async (title: string, content: string, folderId?: string): Promise<DriveFile> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  // 1. Create empty doc via Drive API to support parents
  const metadata: any = {
    name: title,
    mimeType: 'application/vnd.google-apps.document'
  };
  if (folderId) {
    metadata.parents = [folderId];
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,createdTime,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(createData.error?.message || 'Failed to create doc');
  const docId = createData.id;

  // 2. Insert content via Docs API
  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: content
          }
        }
      ]
    })
  });
  
  if (!updateRes.ok) {
    const errData = await updateRes.json();
    throw new Error(errData.error?.message || 'Failed to update doc');
  }

  return createData as DriveFile;
};

export const appendToGoogleDoc = async (docId: string, content: string): Promise<void> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  // Find length to append at end
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const docData = await docRes.json();
  const endIndex = docData.body.content[docData.body.content.length - 1].endIndex;

  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        {
          insertText: {
            location: { index: endIndex - 1 },
            text: '\n\n' + content
          }
        }
      ]
    })
  });
  
  if (!updateRes.ok) {
    const errData = await updateRes.json();
    throw new Error(errData.error?.message || 'Failed to append to doc');
  }
};

export const sendEmail = async (toEmail: string, subject: string, bodyText: string): Promise<void> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  const emailLines = [];
  emailLines.push(`To: ${toEmail}`);
  emailLines.push('Content-type: text/plain;charset=utf-8');
  emailLines.push('MIME-Version: 1.0');
  emailLines.push(`Subject: =?utf-8?B?${btoa(encodeURIComponent(subject).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode('0x' + p1 as any)))}?=`);
  emailLines.push('');
  emailLines.push(bodyText);

  // Encode safely as base64url
  const emailStr = emailLines.join('\r\n');
  const encodedEmail = btoa(encodeURIComponent(emailStr).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode('0x' + p1 as any)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      raw: encodedEmail
    })
  });

  if (!res.ok) {
    const errData = await res.json();
    console.error('Email error:', errData);
    throw new Error(errData.error?.message || 'Failed to send email');
  }
};

export const exportDocAsText = async (fileId: string): Promise<string> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  // Google Drive API export endpoint for Google Docs to plain text
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    throw new Error(errData?.error?.message || 'Failed to export document');
  }

  return await res.text();
};

export const deleteDriveFile = async (fileId: string): Promise<void> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!res.ok) throw new Error("Failed to delete file");
};

export const searchAudioFiles = async (): Promise<DriveFile[]> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  const query = encodeURIComponent(`mimeType contains 'audio/' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,createdTime,webViewLink)&orderBy=modifiedTime desc&pageSize=20`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Failed to search audio files');
  return data.files || [];
};

export const downloadFileAsBlob = async (fileId: string): Promise<Blob> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) throw new Error('Failed to download file');
  return await res.blob();
};

export const renameFile = async (fileId: string, newName: string): Promise<void> => {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: newName
    })
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error?.message || 'Failed to rename file');
  }
};
