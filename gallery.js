/* ==========================================
 * Meme gallery
 *
 * GitHub Pages has no directory listing — a folder with no index file just
 * 404s, and there is no setting to turn one on. So the *list* of files comes
 * from the GitHub contents API, and the files themselves are served from
 * this site (same CDN as everything else, not raw.githubusercontent.com).
 *
 * The repo is public, so the API needs no token — and no token ever
 * reaches the browser.
 *
 * Drop images into /memes/data/ and they show up on their own.
 * ========================================== */
(function () {
  var REPO = 'gaster4432/gaster4432.github.io';
  var FOLDER = 'memes/data';
  var API = 'https://api.github.com/repos/' + REPO + '/contents/' + FOLDER;
  var IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

  /* Images are served from the API's own download URL.
   *
   * The contents API updates the moment a file is pushed, but the site
   * itself takes 10-20 minutes to rebuild. Pointing the images at
   * raw.githubusercontent.com means a newly pushed one shows up straight
   * away instead of 404ing until the next deploy.
   */
  function imageUrl(entry) {
    return entry.download_url;
  }

  function listImages() {
    return fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (res) {
        // A missing folder is not a failure — the gallery is simply empty.
        if (res.status === 404) return [];
        if (!res.ok) throw new Error('GitHub API said ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) return [];
        return data
          .filter(function (e) {
            return e && e.type === 'file' && IMAGE_RE.test(e.name);
          })
          .map(function (e) {
            return {
              name: e.name,
              url: imageUrl(e),
              size: e.size || 0,
            };
          })
          .sort(function (a, b) {
            return a.name.localeCompare(b.name);
          });
      });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ── lightbox ── */

  var lightbox = null;

  function buildLightbox() {
    if (lightbox) return lightbox;
    lightbox = el('div', 'lightbox');
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');

    var close = el('button', 'lightbox-close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeLightbox);

    var img = document.createElement('img');
    img.alt = '';

    lightbox.appendChild(close);
    lightbox.appendChild(img);

    // Clicking the backdrop closes it; clicking the image does not.
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox || e.target === close) closeLightbox();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeLightbox();
    });
    document.body.appendChild(lightbox);
    return lightbox;
  }

  function openLightbox(img) {
    var box = buildLightbox();
    var big = box.querySelector('img');
    big.src = img.url;
    big.alt = img.name;
    box.classList.add('open');
    document.body.classList.add('lightbox-open');
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('open');
    document.body.classList.remove('lightbox-open');
  }

  /* ── rendering ── */

  function renderGrid(target, images, limit) {
    target.innerHTML = '';

    // The target already carries the .gallery-grid class. Nesting a second
    // grid inside it squeezes the items into a single overflowing column.
    target.classList.add('gallery-grid');

    if (!images.length) {
      target.appendChild(el('p', 'gallery-empty',
        'Nothing here yet. Drop an image into the memes/data/ folder and it shows up here.'));
      return 0;
    }

    var shown = limit > 0 ? images.slice(0, limit) : images;

    shown.forEach(function (img) {
      var a = el('a', 'gallery-item');
      a.href = img.url;
      a.title = img.name;

      var im = document.createElement('img');
      im.src = img.url;
      im.alt = img.name;
      im.loading = 'lazy';
      im.decoding = 'async';
      im.addEventListener('error', function () {
        // A broken file should not leave a blank square behind.
        a.classList.add('broken');
        im.remove();
      });

      a.appendChild(im);
      a.addEventListener('click', function (e) {
        e.preventDefault();
        openLightbox(img);
      });

      target.appendChild(a);
    });

    return shown.length;
  }

  function init() {
    var target = document.getElementById('galleryGrid');
    if (!target) return;

    // No limit: the grid shows every image and simply runs onto more rows.
    var limit = 0;

    target.innerHTML = '';
    target.appendChild(el('p', 'gallery-status', 'Loading memes…'));

    listImages()
      .then(function (images) {
        renderGrid(target, images, limit);
      })
      .catch(function (err) {
        target.innerHTML = '';
        target.appendChild(el('p', 'gallery-empty',
          'Could not load the gallery right now — ' + err.message));
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
