import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const callWithRetry = async (fn: () => Promise<any>) => {
  let lastError;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (err.status === 429 || (err.message && err.message.includes("429")) || (err.message && err.message.includes("RESOURCE_EXHAUSTED"))) {
        console.warn(`Gemini API rate limited (429). Retrying in ${RETRY_DELAY_MS}ms... (Attempt ${i + 1}/${MAX_RETRIES})`);
        await sleep(RETRY_DELAY_MS * (i + 1)); // Exponential backoff
        continue;
      }
      throw err;
    }
  }
  throw lastError;
};

export const processAudioWithGemini = async (base64Audio: string, mimeType: string, previousSummary?: string, language: string = 'zh') => {
  const systemLanguage = language === 'zh' ? 'Simplified Chinese' : 'English';

  const prompt = `You are an AI assistant processing voice memos. 
I am sending you the audio recording.
${previousSummary ? 'Previous Memo Summary: ' + previousSummary : 'There is no previous memo.'}

Based on the audio content and the previous memo (if any), please:
1. Provide a short, descriptive title for this memo. If the audio is empty or has no spoken words, make up a generic title (e.g. "Silence").
2. Provide a full transcription.
3. Provide a concise summary.
4. Decide whether this audio content is strongly related to the previous memo and should be "merged" with it, or if it is a conceptually new topic and should be "split" into a new file.
5. Detect if the audio is silent or contains no meaningful human speech. If so, set 'isSilent' to true.
6. Determine the type of the audio (e.g., Meeting, Personal Memo, Interview, Lecture, To-Do List, Journal).
7. Design a rich text HTML document (docHtml) using semantic tags (<h1>, <h2>, <p>, <ul>, <li>, <strong>, etc.) appropriate for this audio type. The HTML should be a document fragment (no <html>, <head>, or <body> tags, just the content). Format it nicely based on the recognized type (e.g., if it's a "Meeting", include headers like "Participants", "Agenda", "Action Items"). Include the title, summary, and transcript inside this HTML in an organized way.

CRITICAL REQUIREMENT: Your title, transcription, summary, and HTML document MUST be entirely in ${systemLanguage}.

Return the result as JSON using the specified schema.
`;

  try {
    const response = await callWithRetry(() => ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [
          { text: prompt },
          { inlineData: { data: base64Audio, mimeType: mimeType } }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: {
              type: Type.STRING,
              description: "A short and descriptive title for this memo (max 5 words). If the transcript is empty or unintelligible, provide a generic title like 'Untitled Memo' or 'Silent Recording'.",
            },
            transcript: {
              type: Type.STRING,
              description: "Full transcription of the audio",
            },
            summary: {
              type: Type.STRING,
              description: "A concise summary of the content",
            },
            docHtml: {
              type: Type.STRING,
              description: "The rich text HTML document tailored to the audio type. Include formatting, headers, paragraphs, and lists as appropriate.",
            },
            action: {
              type: Type.STRING,
              description: "Must be exactly 'merge' or 'split'. Choose merge if the topic strongly continues the previous memo. Choose split if there is no previous memo or the topic is entirely new.",
            },
            isSilent: {
              type: Type.BOOLEAN,
              description: "Set to true if there is no speech or only background noise.",
            }
          },
          required: ["title", "transcript", "summary", "docHtml", "action", "isSilent"]
        }
      }
    }));

    const jsonStr = response.text?.trim() || "{}";
    const result = JSON.parse(jsonStr);
    return {
      title: result.title || "Untitled Memo",
      transcript: result.transcript,
      summary: result.summary,
      docHtml: result.docHtml,
      action: result.action === 'merge' ? 'merge' : 'split',
      isSilent: result.isSilent === true
    };
  } catch (err) {
    console.error("Gemini AI Processing Error:", err);
    throw err;
  }
};

export const mergeDocumentsWithGemini = async (docsContent: string[], language: string = 'zh') => {
  const systemLanguage = language === 'zh' ? 'Simplified Chinese' : 'English';
  
  const prompt = `You are an AI assistant helping to merge multiple voice memos or documents into a single cohesive, well-organized document.
The user wants a document that starts by listing all original transcriptions (grouped or clearly separated) so no raw information is lost, followed by a high-quality summary and reorganized synthesis.

Below are the contents of the individual documents that the user selected to be merged.

CRITICAL REQUIREMENT: Your title, original transcription section, and reorganized synthesis MUST be entirely in ${systemLanguage}.

Return the result as JSON using the specified schema. Please format the mergedContent as a rich HTML document (using <h1>, <h2>, <p>, <ul>, <li>, <strong>, etc.) so it looks great in Google Docs. Make it a complete HTML fragment (no <html>, <head>, or <body> tags, just the content).

Documents to merge:
${docsContent.map((doc, i) => `--- Document ${i + 1} ---\n${doc}\n`).join('\n')}
`;

  try {
    const response = await callWithRetry(() => ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: {
              type: Type.STRING,
              description: "A short, descriptive title for the merged document (max 6 words).",
            },
            mergedContent: {
              type: Type.STRING,
              description: "The full HTML document. MUST include two sections: 1. 'Original Transcriptions' (all raw contents clearly separated) and 2. 'Summary & Synthesis' (the organized reorganized version). Use semantic HTML.",
            },
            summary: {
              type: Type.STRING,
              description: "A very brief overall summary (1-2 sentences).",
            }
          },
          required: ["title", "mergedContent", "summary"]
        }
      }
    }));

    const jsonStr = response.text?.trim() || "{}";
    const result = JSON.parse(jsonStr);
    return {
      title: result.title || "Merged Document",
      mergedContent: result.mergedContent || "",
      summary: result.summary || ""
    };
  } catch (err) {
    console.error("Gemini AI Merging Error:", err);
    throw err;
  }
};
