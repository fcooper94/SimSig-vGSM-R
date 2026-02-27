// Generate MP3 samples for all English Edge TTS voices
// Run: node generate-voice-samples.js

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');

const SAMPLE_TEXT = 'Signal S-X-42 is at danger. Request permission to pass signal at danger for the 1-A-52 Paddington service.';
const OUTPUT_DIR = path.join(__dirname, 'voice-samples');

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  const tts = new MsEdgeTTS();
  const allVoices = await tts.getVoices();

  // Filter to English voices only
  const enVoices = allVoices.filter((v) => v.Locale.startsWith('en-'));
  console.log(`Found ${enVoices.length} English voices. Generating samples...\n`);

  // Print numbered list
  enVoices.forEach((v, i) => {
    console.log(`${String(i + 1).padStart(3)}. ${v.ShortName.padEnd(30)} ${v.Gender.padEnd(8)} ${v.Locale}`);
  });
  console.log('');

  for (let i = 0; i < enVoices.length; i++) {
    const v = enVoices[i];
    const filename = `${String(i + 1).padStart(2, '0')}-${v.ShortName}.mp3`;
    const outPath = path.join(OUTPUT_DIR, filename);

    if (fs.existsSync(outPath)) {
      console.log(`[${i + 1}/${enVoices.length}] Skipping ${v.ShortName} (exists)`);
      continue;
    }

    try {
      const inst = new MsEdgeTTS();
      await inst.setMetadata(v.ShortName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = inst.toStream(SAMPLE_TEXT);

      const chunks = [];
      await new Promise((resolve, reject) => {
        audioStream.on('data', (chunk) => chunks.push(chunk));
        audioStream.on('end', resolve);
        audioStream.on('error', reject);
      });

      const buffer = Buffer.concat(chunks);
      fs.writeFileSync(outPath, buffer);
      console.log(`[${i + 1}/${enVoices.length}] ${v.ShortName} -> ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error(`[${i + 1}/${enVoices.length}] FAILED ${v.ShortName}: ${err.message}`);
    }
  }

  console.log(`\nDone! Samples saved to: ${OUTPUT_DIR}`);
  console.log('Open the folder and play each MP3 to pick your favourites.');
}

main().catch(console.error);
