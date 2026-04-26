export interface AudioRecord {
  id: string;
  blob: Blob;
  base64: string;
  mimeType: string;
  location?: GeolocationCoordinates;
  timestamp: number;
}

export interface ProcessedRecord {
  id: string;
  transcript: string;
  summary: string;
  action: 'merge' | 'split';
  driveFileId?: string;
  docId?: string;
}
