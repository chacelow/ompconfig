#!/usr/bin/env python3
"""Fetch a YouTube video's title and transcript via yt-dlp."""

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile


def run_yt_dlp(arguments):
    try:
        return subprocess.run(
            ["yt-dlp", *arguments], capture_output=True, text=True, check=True
        )
    except FileNotFoundError:
        print("yt-dlp is not installed or not on PATH.", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.CalledProcessError as error:
        print(error.stderr.strip() or "yt-dlp failed.", file=sys.stderr)
        raise SystemExit(1)


def get_metadata(url):
    result = run_yt_dlp(["--dump-json", "--no-warnings", "--skip-download", url])
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        print(f"Invalid metadata returned by yt-dlp: {error}", file=sys.stderr)
        raise SystemExit(1)


def language_candidates(languages, requested):
    if not requested:
        return []
    exact = [requested] if requested in languages else []
    prefix = requested.split("-", 1)[0].lower()
    variants = [
        language
        for language in languages
        if language not in exact and language.lower().split("-", 1)[0] == prefix
    ]
    return [*exact, *variants]


def pick_caption(info, requested_language=None):
    manual = info.get("subtitles") or {}
    automatic = info.get("automatic_captions") or {}
    original_language = info.get("language")
    preferences = []
    if requested_language:
        preferences.append(requested_language)
    if original_language and original_language not in preferences:
        preferences.append(original_language)
    if "en" not in preferences:
        preferences.append("en")

    for tracks, is_automatic in ((manual, False), (automatic, True)):
        for preference in preferences:
            candidates = language_candidates(tracks, preference)
            if candidates:
                return candidates[0], is_automatic
    if manual:
        return next(iter(manual)), False
    if automatic:
        return next(iter(automatic)), True
    return None


def download_caption(url, language, is_automatic, output_directory):
    mode = "--write-auto-subs" if is_automatic else "--write-subs"
    run_yt_dlp([
        "--skip-download", "--no-warnings", "--sub-format", "json3",
        "--sub-langs", language, mode,
        "-o", os.path.join(output_directory, "%(id)s.%(ext)s"), url,
    ])
    matches = glob.glob(os.path.join(output_directory, "*.json3"))
    if not matches:
        print("yt-dlp did not produce a json3 subtitle file.", file=sys.stderr)
        raise SystemExit(1)
    return matches[0]


def extract_text(path):
    with open(path, encoding="utf-8") as file:
        data = json.load(file)
    parts = []
    for event in data.get("events", []):
        for segment in event.get("segs") or []:
            text = segment.get("utf8", "").strip()
            if text:
                parts.append(text)
    return " ".join(parts)


def main():
    if len(sys.argv) not in (2, 3):
        print("Usage: fetch_transcript.py <youtube_url> [preferred_language]", file=sys.stderr)
        raise SystemExit(2)
    url = sys.argv[1]
    requested_language = sys.argv[2] if len(sys.argv) == 3 else None
    info = get_metadata(url)
    title = info.get("title") or "Unknown title"
    caption = pick_caption(info, requested_language)
    if caption is None:
        print(f"No subtitles found for video: {title}", file=sys.stderr)
        raise SystemExit(1)
    language, is_automatic = caption
    temporary_directory = tempfile.mkdtemp(prefix="youtube-transcript-")
    try:
        caption_path = download_caption(url, language, is_automatic, temporary_directory)
        transcript = extract_text(caption_path)
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)
    print(json.dumps({
        "title": title,
        "language": language,
        "automatic": is_automatic,
        "transcript": transcript,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
