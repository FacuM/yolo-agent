---
name: youtube-step-extractor
description: Extract frames from a YouTube video and analyze them to identify a sequence of steps. Use when user provides a YouTube URL and wants to understand the process, tutorial, or workflow shown in the video by examining its visual content frame-by-frame. Triggers on "extract steps from video", "what steps does this video show", "analyze YouTube tutorial", "screenshot a video", "figure out the steps".
---

# YouTube Step Extractor

Download a YouTube video, extract frames at regular intervals, and analyze them to identify a specific sequence of steps from the visual content.

## Prerequisites

Requires `yt-dlp` and `ffmpeg`:

```bash
# Ubuntu/Debian
sudo apt-get install -y ffmpeg
pip install yt-dlp

# macOS
brew install ffmpeg yt-dlp
```

## Workflow

### Step 1: Download the YouTube video

```bash
yt-dlp -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]" \
  -o "/tmp/yt_video.mp4" \
  --merge-output-format mp4 \
  "YOUTUBE_URL"
```

For faster download (lower quality is fine for frame analysis):

```bash
yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" \
  -o "/tmp/yt_video.mp4" \
  --merge-output-format mp4 \
  "YOUTUBE_URL"
```

### Step 2: Extract frames

Use the bundled script:

```bash
{baseDir}/scripts/extract_frames.sh /tmp/yt_video.mp4 /tmp/yt_frames 1
```

Arguments:
- `video_path` (required): Path to the downloaded video
- `output_dir` (optional): Where to save frames. Default: `./frames_<video_name>`
- `fps` (optional): Frames per second. Default: `1` (one frame per second)

For longer videos, reduce fps to avoid too many frames:

```bash
# 1 frame every 2 seconds for videos > 5 min
{baseDir}/scripts/extract_frames.sh /tmp/yt_video.mp4 /tmp/yt_frames 0.5

# 1 frame every 5 seconds for videos > 15 min
{baseDir}/scripts/extract_frames.sh /tmp/yt_video.mp4 /tmp/yt_frames 0.2
```

Or use the all-in-one script:

```bash
{baseDir}/scripts/download_and_extract.sh "YOUTUBE_URL" /tmp/yt_frames 1
```

### Step 3: Analyze the frames

1. List the extracted frames: `ls /tmp/yt_frames/`
2. Read key frames using the image viewing tool
3. For comprehensive analysis, sample frames at regular intervals (e.g., every 5th frame)
4. Identify **distinct steps** by looking for:
   - Scene/screen transitions
   - UI changes (new dialogs, menus, pages)
   - Text overlays, titles, or captions
   - Actions being performed (clicks, typing, navigation)
   - Before/after states
5. Build a numbered step-by-step summary of the process shown

### Step 4: (Optional) Extract transcript for context

Subtitles add context to what's visible in the frames:

```bash
yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format vtt \
  -o "/tmp/yt_transcript" "YOUTUBE_URL"
```

Clean to plain text:

```bash
sed -e '/^$/d' -e '/^[0-9]/d' -e '/-->/d' -e 's/<[^>]*>//g' \
  /tmp/yt_transcript.en.vtt | sort -u > /tmp/yt_transcript.txt
```

## Tips

- **Short videos (<2 min):** Use `fps=1`, review all frames
- **Medium videos (2-10 min):** Use `fps=0.5`, sample every 3-5 frames
- **Long videos (>10 min):** Use `fps=0.2`, focus on scene changes
- **Tutorials/screencasts:** Higher fps (1-2) captures more UI transitions
- **Presentations/talks:** Lower fps (0.2-0.5) is sufficient
- Combine frame analysis with transcript for best results
- Look for: screen transitions, text changes, button clicks, new panels/dialogs

## Output

The extracted frames are numbered sequentially: `frame_001.jpg`, `frame_002.jpg`, etc.

Each frame filename corresponds to its position in time:
- At `fps=1`: `frame_001.jpg` = ~1s, `frame_060.jpg` = ~60s
- At `fps=0.5`: `frame_001.jpg` = ~2s, `frame_030.jpg` = ~60s

## Cleanup

```bash
rm -rf /tmp/yt_video.mp4 /tmp/yt_frames /tmp/yt_transcript*
```
