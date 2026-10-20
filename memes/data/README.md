# memes/data

This is the folder the gallery reads. Drop images in here and they show up
on the site on their own — there is nothing to configure or register.

- **Works with:** `.png` `.jpg` `.jpeg` `.gif` `.webp` `.avif` `.svg` `.bmp`
- **Keep files small** (under ~1 MB if you can). The gallery serves the
  original file, not a resized copy, so a 5 MB photo will feel slow.
- **Images must sit directly in this folder.** Sub-folders are ignored.
- The gallery is on the [home page](/), and has its own pages at
  [/memes/](/memes/) and [/memes/data/](/memes/data/).

## How the list works

GitHub Pages has no directory listing, so the *list* of filenames comes
from the GitHub contents API. The images themselves are served from
`gaster4432.github.io`, the same as every other file on the site.

That means a newly pushed image can take a minute to appear while GitHub's
API cache catches up. Nothing to do about it — it is GitHub's side.
