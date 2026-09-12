# Pinned FFmpeg build source

`ffmpeg-8.1.2.tar.xz` is the unmodified official release from
https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.

SHA256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`

Its release signature was verified against the FFmpeg release signing key
`FCF986EA15E6E293A5644F10B4322F04D67658D8`. The build checks the pinned SHA256
again before extraction and compiles the same restricted audio-only decoder.
The archive includes upstream source and license files.

Keeping the source here lets deployment builds work when ffmpeg.org is
unreachable. A missing archive falls back to the official download; a corrupted
archive fails the build. Update the archive and installer pin together only
after verifying a new upstream release signature.
