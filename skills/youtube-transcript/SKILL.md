---
name: youtube-transcript
description: Fetch a YouTube video's title and spoken transcript as JSON for analysis, summarization, quoting, or search. Use when the user provides a YouTube URL or asks to inspect a video's spoken content.
---

# YouTube Transcript

使用 `yt-dlp` 获取 YouTube 视频标题和字幕，并输出适合后续分析的 JSON。

## Requirements

- `yt-dlp` on `PATH`
- Python 3

## Usage

```bash
python3 ~/.agents/skills/youtube-transcript/fetch_transcript.py "<youtube_url>" [preferred_language]
```

`preferred_language` 可选，例如 `zh-Hans`、`zh` 或 `en`。如果用户明确指定字幕语言，传入该值；否则脚本依次选择视频原始语言、英文、任意人工字幕、任意自动字幕。每个阶段都优先精确语言，再接受同语言前缀变体。

## Output

stdout 输出：

```json
{
  "title": "Video title",
  "language": "zh-Hans",
  "automatic": false,
  "transcript": "full transcript text"
}
```

进度和错误写入 stderr。无字幕、网络错误或 URL 无效时返回非零状态。
- YouTube 要求登录或反机器人验证时，脚本会保留 `yt-dlp` 的原始错误并退出；不要未经用户明确允许读取浏览器 Cookies。

## Boundaries

- 优先人工字幕，再使用自动字幕。
- 保留字幕原语言，不自动翻译；用户要求翻译时，在获取原文后单独翻译。
- 输出为去除时间和格式的纯文本，不适合需要精确时间戳的任务。
- 不下载视频或音频。
