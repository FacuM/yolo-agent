#!/bin/bash
# Extract frames from a video at specified intervals
# Adapted from openclaw/skills kartinw/video-watcher
#
# Usage: extract_frames.sh <video_path> [output_dir] [fps]

set -e

VIDEO_PATH="$1"
OUTPUT_DIR="${2:-}"
FPS="${3:-1}"

if [ -z "$VIDEO_PATH" ]; then
    echo "Usage: extract_frames.sh <video_path> [output_dir] [fps]"
    echo ""
    echo "Arguments:"
    echo "  video_path  Path to the video file (required)"
    echo "  output_dir  Directory for extracted frames (optional)"
    echo "  fps         Frames per second to extract (default: 1)"
    echo ""
    echo "Examples:"
    echo "  extract_frames.sh video.mp4                    # 1 fps, auto output dir"
    echo "  extract_frames.sh video.mp4 ./frames           # 1 fps, custom dir"
    echo "  extract_frames.sh video.mp4 ./frames 0.5       # 1 frame every 2s"
    echo "  extract_frames.sh video.mp4 ./frames 2         # 2 fps"
    exit 1
fi

if [ ! -f "$VIDEO_PATH" ]; then
    echo "Error: Video file not found: $VIDEO_PATH"
    exit 1
fi

# Check if ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "Error: ffmpeg is not installed"
    echo "Install with:"
    echo "  Ubuntu/Debian: sudo apt-get install -y ffmpeg"
    echo "  macOS: brew install ffmpeg"
    exit 1
fi

# Get video filename without extension
VIDEO_NAME=$(basename "$VIDEO_PATH" | sed 's/\.[^.]*$//')

# Set output directory
if [ -z "$OUTPUT_DIR" ]; then
    OUTPUT_DIR="./frames_${VIDEO_NAME}"
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Get video info
echo "=== Video Information ==="
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO_PATH" 2>/dev/null || echo "unknown")
RESOLUTION=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$VIDEO_PATH" 2>/dev/null || echo "unknown")
echo "File: $VIDEO_PATH"
echo "Duration: ${DURATION}s"
echo "Resolution: $RESOLUTION"
echo "FPS to extract: $FPS"

# Estimate frame count
if [ "$DURATION" != "unknown" ]; then
    ESTIMATED=$(echo "$DURATION * $FPS" | bc -l 2>/dev/null | cut -d. -f1 || echo "?")
    echo "Estimated frames: ~$ESTIMATED"
fi
echo ""

# Extract frames
echo "=== Extracting Frames ==="
ffmpeg -i "$VIDEO_PATH" -vf "fps=$FPS" "$OUTPUT_DIR/frame_%03d.jpg" -y -loglevel warning

# Count extracted frames
FRAME_COUNT=$(ls -1 "$OUTPUT_DIR"/frame_*.jpg 2>/dev/null | wc -l)

echo ""
echo "=== Complete ==="
echo "Extracted $FRAME_COUNT frames to: $OUTPUT_DIR"
echo ""
echo "Frames:"
ls -la "$OUTPUT_DIR"/frame_*.jpg | head -20
if [ "$FRAME_COUNT" -gt 20 ]; then
    echo "... and $((FRAME_COUNT - 20)) more"
fi
