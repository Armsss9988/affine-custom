/**
 * tts.js - Google Cloud Text-to-Speech REST API wrapper
 *
 * Reuses the ADC token from gemini.js (no new npm deps needed).
 * Calls: https://texttospeech.googleapis.com/v1/text:synthesize
 * Returns: Buffer (MP3 audio binary)
 *
 * Voices (Vietnamese):
 *   vi-VN-Neural2-A  — Neural2, female (best quality)
 *   vi-VN-Neural2-D  — Neural2, male
 *   vi-VN-Wavenet-A  — WaveNet, female
 *   vi-VN-Wavenet-B  — WaveNet, male
 *
 * Voices (English):
 *   en-US-Journey-F  — Journey, female (most natural)
 *   en-US-Journey-D  — Journey, male
 *   en-US-Neural2-D  — Neural2, male
 *   en-US-Neural2-F  — Neural2, female
 */

const https = require('https');
const { getAccessToken } = require('./gemini');

const VERTEX_PROJECT = process.env.VERTEX_PROJECT || '';

// ─── Supported voices (for validation) ──────────────────────────────────────
const SUPPORTED_VOICES = {
  'vi-VN': ['vi-VN-Neural2-A', 'vi-VN-Neural2-D', 'vi-VN-Wavenet-A', 'vi-VN-Wavenet-B'],
  'en-US': ['en-US-Journey-F', 'en-US-Journey-D', 'en-US-Neural2-D', 'en-US-Neural2-F'],
  'en-GB': ['en-GB-Neural2-A', 'en-GB-Neural2-B'],
};

// Default voices per language
const DEFAULT_VOICE = {
  'vi-VN': 'vi-VN-Neural2-A',
  'en-US': 'en-US-Journey-F',
  'en-GB': 'en-GB-Neural2-A',
};

/**
 * Synthesize speech using Google Cloud TTS REST API.
 *
 * @param {string} text - The text to synthesize (max 5000 bytes)
 * @param {object} options
 * @param {string} [options.languageCode='vi-VN'] - BCP-47 language code
 * @param {string} [options.voice] - Voice name (auto-selected if omitted)
 * @param {number} [options.speakingRate=1.0] - Speed: 0.25 to 4.0
 * @param {number} [options.pitch=0.0] - Pitch: -20.0 to 20.0 semitones
 * @param {string} [options.audioEncoding='MP3'] - 'MP3', 'LINEAR16', 'OGG_OPUS'
 * @returns {Promise<Buffer>} - Audio binary buffer
 */
async function synthesizeSpeech(text, options = {}) {
  if (!text || typeof text !== 'string') {
    throw new Error('[TTS] text is required and must be a string');
  }

  // Clamp text length (TTS API limit: 5000 bytes)
  const MAX_BYTES = 4900;
  const textBuffer = Buffer.from(text, 'utf8');
  const truncatedText = textBuffer.length > MAX_BYTES
    ? textBuffer.slice(0, MAX_BYTES).toString('utf8')
    : text;

  const languageCode = options.languageCode || 'vi-VN';
  const voiceName = options.voice || DEFAULT_VOICE[languageCode] || 'vi-VN-Neural2-A';
  const speakingRate = Math.min(4.0, Math.max(0.25, options.speakingRate || 1.0));
  const pitch = Math.min(20.0, Math.max(-20.0, options.pitch || 0.0));
  const audioEncoding = options.audioEncoding || 'MP3';

  const token = await getAccessToken();

  const requestBody = JSON.stringify({
    input: { text: truncatedText },
    voice: {
      languageCode,
      name: voiceName,
    },
    audioConfig: {
      audioEncoding,
      speakingRate,
      pitch,
      // Slight volume boost for clarity
      volumeGainDb: 0.0,
    },
  });

  console.log(`[TTS] Synthesizing ${truncatedText.length} chars | lang=${languageCode} voice=${voiceName} rate=${speakingRate}`);

  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: 'texttospeech.googleapis.com',
      path: '/v1/text:synthesize',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(requestBody),
      },
    };

    // Add project header if configured (for billing attribution)
    if (VERTEX_PROJECT) {
      reqOptions.headers['x-goog-user-project'] = VERTEX_PROJECT;
    }

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (res.statusCode !== 200) {
            const errMsg = json.error?.message || `HTTP ${res.statusCode}: ${data.slice(0, 200)}`;
            console.error('[TTS] API error:', errMsg);
            return reject(new Error(`[TTS] Google Cloud TTS error: ${errMsg}`));
          }

          if (!json.audioContent) {
            return reject(new Error('[TTS] No audioContent in response'));
          }

          const audioBuffer = Buffer.from(json.audioContent, 'base64');
          console.log(`[TTS] Success — ${audioBuffer.length} bytes (${audioEncoding})`);
          resolve(audioBuffer);
        } catch (parseErr) {
          reject(new Error(`[TTS] Failed to parse response: ${parseErr.message}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('[TTS] Request error:', err);
      reject(err);
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * Get list of available voices for a language code.
 * Calls: GET https://texttospeech.googleapis.com/v1/voices?languageCode=vi-VN
 */
async function listVoices(languageCode) {
  const token = await getAccessToken();
  const query = languageCode ? `?languageCode=${encodeURIComponent(languageCode)}` : '';

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (VERTEX_PROJECT) {
    headers['x-goog-user-project'] = VERTEX_PROJECT;
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'texttospeech.googleapis.com',
      path: `/v1/voices${query}`,
      method: 'GET',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) {
            return reject(new Error(`[TTS] listVoices error: ${json.error?.message || data}`));
          }
          resolve(json.voices || []);
        } catch (e) {
          reject(new Error(`[TTS] Failed to parse voices response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}


module.exports = { synthesizeSpeech, listVoices, SUPPORTED_VOICES, DEFAULT_VOICE };
