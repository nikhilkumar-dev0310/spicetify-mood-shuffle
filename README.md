# Mood Shuffle

A Spicetify extension that asks **which artist you're in the mood for** and then shuffles only that artist's songs from **your own library**, so no other artists sneak in.

![Mood Shuffle preview](preview.png)

## Features

- A button in the top bar (or **Cmd+Shift+M** / **Ctrl+Shift+M**) opens a picker.
- Every artist in your library is listed, so you pick one and don't have to type.
- You can sort by **Most songs** or **A–Z**, and jump to a letter.
- Songs come only from your playlists (including ones inside folders) and, if you want, your Liked Songs.
- It clears your queue, shuffles the artist's songs and plays them.
- Options: *Only playlists I created* and *Include Liked Songs*.

## Install

**Marketplace:** open Marketplace in Spotify, search for **Mood Shuffle** and click Install.

**Manual:**

```bash
cp moodShuffle.js ~/.config/spicetify/Extensions/
spicetify config extensions moodShuffle.js
spicetify apply
```

## Tip

Turn off **Autoplay** in Spotify Settings → Playback. If it's on, Spotify starts playing "similar" songs by other artists when your mix ends.
