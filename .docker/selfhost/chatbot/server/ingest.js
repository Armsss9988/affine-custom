const fs = require('fs');
const path = require('path');
const { pool, initSchema } = require('./db');
const { embedText } = require('./nim');

const CHUNK_SIZE = 400;       // ~400 words per chunk
const CHUNK_OVERLAP = 50;     // 50 words overlap
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || path.join(__dirname, '..', 'knowledge');

/**
 * Split text into overlapping chunks by words
 */
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const chunks = [];

  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    if (chunk.trim().length > 20) {
      chunks.push(chunk);
    }
    if (i + chunkSize >= words.length) break;
  }

  return chunks;
}

/**
 * Split markdown by headings for better semantic chunks
 */
function chunkMarkdown(text) {
  const sections = [];
  const lines = text.split('\n');
  let currentSection = '';
  let currentHeading = '';

  for (const line of lines) {
    if (line.match(/^#{1,3}\s+/)) {
      // Save previous section
      if (currentSection.trim().length > 20) {
        sections.push({
          heading: currentHeading,
          content: currentSection.trim(),
        });
      }
      currentHeading = line.replace(/^#+\s+/, '');
      currentSection = line + '\n';
    } else {
      currentSection += line + '\n';
    }
  }

  // Save last section
  if (currentSection.trim().length > 20) {
    sections.push({
      heading: currentHeading,
      content: currentSection.trim(),
    });
  }

  // Further chunk large sections
  const chunks = [];
  for (const section of sections) {
    if (section.content.split(/\s+/).length > CHUNK_SIZE) {
      const subChunks = chunkText(section.content);
      subChunks.forEach((chunk, i) => {
        chunks.push({
          content: chunk,
          heading: section.heading,
          subIndex: i,
        });
      });
    } else {
      chunks.push({
        content: section.content,
        heading: section.heading,
        subIndex: 0,
      });
    }
  }

  return chunks;
}

/**
 * Ingest a single markdown file into pgvector
 */
async function ingestFile(filePath, teamId = null) {
  const fileName = path.basename(filePath);
  console.log(`[Ingest] Processing: ${fileName} (team: ${teamId || 'global'})`);

  const text = fs.readFileSync(filePath, 'utf-8');
  const chunks = chunkMarkdown(text);

  console.log(`[Ingest] Found ${chunks.length} chunks`);

  // Delete existing chunks for this source + team
  await pool.query(
    'DELETE FROM chatbot_documents WHERE source = $1 AND (team_id = $2 OR ($2 IS NULL AND team_id IS NULL))',
    [fileName, teamId]
  );

  let embedded = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const embedding = await embedText(chunk.content);
      const vectorStr = `[${embedding.join(',')}]`;

      await pool.query(
        `INSERT INTO chatbot_documents (content, embedding, source, chunk_index, team_id, metadata)
         VALUES ($1, $2::vector, $3, $4, $5, $6)`,
        [
          chunk.content,
          vectorStr,
          fileName,
          i,
          teamId,
          JSON.stringify({ heading: chunk.heading || '' }),
        ]
      );

      embedded++;
      // Rate limiting for NIM free tier
      if (i > 0 && i % 5 === 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`[Ingest] Error embedding chunk ${i}:`, err.message);
    }
  }

  console.log(`[Ingest] ✅ ${fileName}: ${embedded}/${chunks.length} chunks embedded`);
  return embedded;
}

/**
 * Ingest all markdown files from knowledge directory
 */
async function ingestAll() {
  await initSchema();

  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.error(`[Ingest] Knowledge directory not found: ${KNOWLEDGE_DIR}`);
    return;
  }

  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
  console.log(`[Ingest] Found ${files.length} markdown files`);

  let totalChunks = 0;
  for (const file of files) {
    // Files starting with "team-" are team-specific
    const teamMatch = file.match(/^team-([^-]+)-/);
    const teamId = teamMatch ? teamMatch[1] : null;

    const filePath = path.join(KNOWLEDGE_DIR, file);
    const count = await ingestFile(filePath, teamId);
    totalChunks += count;
  }

  console.log(`\n[Ingest] 🎉 Done! Total: ${totalChunks} chunks ingested`);

  // Show stats
  const stats = await pool.query(
    `SELECT team_id, source, COUNT(*) as chunks
     FROM chatbot_documents
     GROUP BY team_id, source
     ORDER BY team_id NULLS FIRST, source`
  );
  console.table(stats.rows);
}

// Run directly: node server/ingest.js
if (require.main === module) {
  ingestAll()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[Ingest] Fatal:', err);
      process.exit(1);
    });
}

module.exports = { ingestFile, ingestAll, chunkMarkdown };
