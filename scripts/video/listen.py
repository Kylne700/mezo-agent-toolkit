# Copied from the author's own MIT-licensed Sealdrop video chain (github.com/Kylne700/sealdrop).
# Transcribes audio with faster-whisper and writes every word with its times as JSON (the listening check of the demo video).
#   python3 -I scripts/video/listen.py <model dir> <audio or video file> <out.json> ["initial prompt"]
# -I ignores the user site, where faster-whisper is installed, so it is added by hand. The model dir is a download in /tmp.
import json
import site
import sys

sys.path.append(site.getusersitepackages())
from faster_whisper import WhisperModel  # noqa: E402

model_dir, audio, out = sys.argv[1:4]
prompt = sys.argv[4] if len(sys.argv) > 4 else None
model = WhisperModel(model_dir, device='cpu', compute_type='int8')
segments, info = model.transcribe(audio, language='en', beam_size=5, word_timestamps=True, condition_on_previous_text=False, initial_prompt=prompt, vad_filter=True)
words = [{'w': w.word.strip(), 'start': round(w.start, 3), 'end': round(w.end, 3), 'p': round(w.probability, 3)} for s in segments for w in s.words]
with open(out, 'w') as f:
    json.dump({'duration': round(info.duration, 2), 'prompt': prompt, 'words': words}, f)
print(f'{len(words)} words in {info.duration:.1f} s')
