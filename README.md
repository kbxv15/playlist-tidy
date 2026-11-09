# Playlist Tidy for YouTube Music

A Chrome extension that adds a **Tidy** panel to music.youtube.com for cleaning up your playlist library.

## Install

1. Unzip this folder somewhere you'll keep it (Chrome loads it from there).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `playlist-tidy` folder.
4. Open [music.youtube.com/library/playlists](https://music.youtube.com/library/playlists) and click the **Tidy** button (bottom right), the toolbar icon, or press **Alt+Shift+T**.

## What it does

- **Scan** every playlist for duplicate songs, unavailable (greyed-out) songs, and empty playlists. Click a result chip to select those playlists.
- **Delete** many playlists at once. Ones you made are deleted; ones saved from others are just removed from your library. A backup file is downloaded first by default.
- **Clean up**: remove duplicates and unavailable songs from selected playlists in one go. The first copy of each song is kept.
- **Sort** a playlist by title, artist, album or length, reverse it, or shuffle it. Only songs that are out of place are moved.
- **Merge** several playlists into a new one, with duplicates removed.
- **Back up / Restore**: save playlists to a JSON file and recreate them later.
- Optional **Match same title & artist** setting catches the same song uploaded twice (e.g. single vs. album version).

Click any playlist to see its songs, filter to duplicates or unavailable ones, and remove specific songs.

## Notes

- It works with the YouTube Music account you're signed into in that tab, using YouTube Music's own web requests. Nothing is sent anywhere else, and it needs no permissions beyond music.youtube.com.
- After making changes, refresh YouTube Music to see them in its own pages.
- Liked Music and Episodes for Later are automatic playlists and can't be changed here.
- YouTube Music has no official API for this, so a future YouTube change could break something. If an action fails, you'll see YouTube's error message, and anything already done stays done.
