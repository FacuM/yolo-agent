#!/bin/bash
# Download a YouTube video and extract frames in one step
#
# Usage: download_and_extract.sh <youtube_url> [output_dir] [fps] [max_height]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
YOUTUBE_URL="$1"
OUTPUT_DIR="${2:-/tmp/yt_frames}"
FPS="${3:-1}"
MAX_HEIGHT="${4:-720}"

if [ -z "$YOUTUBE_URL" ]; then
    echo "Usage: download_and_extract.sh <youtube_url> [output_dir] [fps] [max_height]"
    echo ""
    echo "Arguments:"
    echo "  youtube_url  YouTube video URL (required)"
    echo "  output_dir   Directory for extracted frames (default: /tmp/yt_frames)"
    echo "  fps          Frames per second to extract (default: 1)"
    echo "  max_height   Max video height in px (default: 720, lower = faster download)"
    echo ""
    echo "Examples:"
    echo "  download_and_extract.sh 'https://youtube.com/watch?v=xxx'"
    echo "  download_and_extract.sh 'https://youtube.com/watch?v=xxx' ./frames 0.5"
    echo "  download_and_extract.sh 'https://youtube.com/watch?v=xxx' ./frames 1 1080"
    exit 1
fi

# Check dependencies
for cmd in yt-dlp ffmpeg; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: $cmd is not installed"
        echo "Install with:"
        echo "  yt-dlp: pip install yt-dlp"
        echo "  ffmpeg: sudo apt-get install -y ffmpeg (or brew install ffmpeg)"
        exit 1
    fi
done

# Create temp dir for video
TEMP_VIDEO="/tmp/yt_step_extractor_$$.mp4"

echo "=== Step 1: Downloading YouTube Video ==="
echo "URL: $YOUTUBE_URL"
echo "Max resolution: ${MAX_HEIGHT}p"
echo ""

yt-dlp \
    -f "bestvideo[height<=${MAX_HEIGHT}]+bestaudio/best[height<=${MAX_HEIGHT}]" \
    -o "$TEMP_VIDEO" \
    --merge-output-format mp4 \
    --no-playlist \
    "$YOUTUBE_URL"

if [ ! -f "$TEMP_VIDEO" ]; then
    echo "Error: Failed to download video"
    exit 1
fi

echo ""
echo "=== Step 2: Extracting Frames ==="
"$SCRIPT_DIR/extract_frames.sh" "$TEMP_VIDEO" "$OUTPUT_DIR" "$FPS"

echo ""
echo "=== Step 3: Cleanup ==="
rm -f "$TEMP_VIDEO"
echo "Removed temporary video file"

echo ""
echo "=== Done ==="
echo "Frames are ready for analysis in: $OUTPUT_DIR"
echo ""
echo "Suggested next steps:"
echo "  1. List frames: ls $OUTPUT_DIR/"
echo "  2. View key frames to identify distinct steps"
echo "  3. Look for: UI transitions, text changes, new screens"
