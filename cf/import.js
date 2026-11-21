/* ==========================================
 * PKAX character-card import
 *
 * Reads SillyTavern-style character cards (V1 flat / V2 `chara` / V3
 * `ccv3`) from:
 *   - a Chub / CharacterHub character page link
 *   - a direct URL to a card PNG or JSON
 *   - a local .png / .json file
 *
 * Card JSON is base64 inside a PNG tEXt chunk named `chara` (V2) or
 * `ccv3` (V3); V3 wins when both are present. Older cards from
 * Risu/JanitorAI wrap the JSON in base64(zlib(json)), so that is tried
 * as a fallback. The Chub API is used for links because its `definition`
 * is newer and more complete than the PNG's embedded copy (see the
 * SillyTavern #4312 metadata-staleness bug).
 *
 * `{{char}}` becomes the character's name and `{{user}}` becomes "user".
 *
 * This file only parses and normalises. Adding the character, saving it
 * and publishing it live in app.js.
 * ========================================== */
(function () {
  'use strict';

  var MAX_FILE_BYTES = 15 * 1024 * 1024;

  function utf8(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .trim();
  }

  function indexOfZero(bytes) {
    for (var i = 0; i < bytes.length; i++) if (bytes[i] === 0) return i;
    return -1;
  }

  function asList(value, splitComma) {
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
    if (typeof value === 'string') {
      return value.split(splitComma ? /[,\n]/ : '\n').map(cleanText).filter(Boolean);
    }
    return [];
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      var buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      return null;
    }
  }

  async function decodePayload(text) {
    var trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('The card data is empty.');

    // Raw JSON (some tools write it without base64).
    try { return JSON.parse(trimmed); } catch (e) { /* not raw JSON */ }

    var binary;
    try {
      binary = atob(trimmed.replace(/\s+/g, ''));
    } catch (e) {
      throw new Error('Could not decode the card data.');
    }

    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // base64(utf8(json)) — what SillyTavern writes.
    try { return JSON.parse(utf8(bytes)); } catch (e) { /* try zlib next */ }

    // base64(zlib(json)) — older Risu / JanitorAI cards.
    var inflated = await inflate(bytes);
    if (inflated) {
      try { return JSON.parse(utf8(inflated)); } catch (e) { /* fall through */ }
    }

    throw new Error('Could not decode the card data.');
  }

  /** Pull the embedded card JSON out of a PNG. `ccv3` beats `chara`. */
  async function extractCardFromPng(bytes) {
    if (!bytes || bytes.length < 8) throw new Error('That file is not a PNG.');
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
      throw new Error('That file is not a PNG.');
    }

    var chara = null;
    var ccv3 = null;
    var i = 8;

    while (i + 8 <= bytes.length) {
      var len = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      var type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
      var data = bytes.subarray(i + 8, i + 8 + len);

      if (type === 'tEXt') {
        var z = indexOfZero(data);
        if (z >= 0) {
          var key = utf8(data.subarray(0, z)).toLowerCase();
          var text = utf8(data.subarray(z + 1));
          if (key === 'chara') chara = text;
          else if (key === 'ccv3') ccv3 = text;
        }
      } else if (type === 'zTXt') {
        var z2 = indexOfZero(data);
        // zTXt: keyword\0 compression-method(0) compressed-text
        if (z2 >= 0 && z2 + 2 < data.length && data[z2 + 1] === 0) {
          var key2 = utf8(data.subarray(0, z2)).toLowerCase();
          var out = await inflate(data.subarray(z2 + 2));
          if (out) {
            var text2 = utf8(out);
            if (key2 === 'chara') chara = text2;
            else if (key2 === 'ccv3') ccv3 = text2;
          }
        }
      }

      if (type === 'IEND') break;
      i += 12 + len;
    }

    var payload = ccv3 || chara;
    if (!payload) throw new Error('No character data was found in that PNG.');
    return decodePayload(payload);
  }

  /** `{{char}}` -> the character name, `{{user}}` -> "user". */
  function substitutePlaceholders(text, name) {
    return String(text == null ? '' : text)
      .replace(/\{\{\s*char\s*\}\}/gi, name || 'char')
      .replace(/\{\{\s*user\s*\}\}/gi, 'user');
  }

  /**
   * Turn any supported card shape into the fields PKAX uses.
   * Accepts `{spec, data}`, a flat V1 object, or a gradio/Pygmalion object.
   */
  function normalizeCard(raw, opts) {
    opts = opts || {};
    var data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object'
      ? raw.data
      : (raw || {});

    // gradio / Pygmalion notepad export.
    if (data.char_name !== undefined) {
      data = {
        name: data.char_name,
        description: data.char_persona || '',
        personality: '',
        scenario: data.world_scenario || '',
        first_mes: data.char_greeting || '',
        mes_example: data.example_dialogue || '',
        creator_notes: data.creator_notes || data.creatorcomment || '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: data.tags || [],
        creator: data.creator || '',
        character_version: '',
        extensions: {},
        character_book: null,
        avatar: ''
      };
    }

    var name = cleanText(data.name || opts.name || 'Imported Character').slice(0, 48)
      || 'Imported Character';

    var description = cleanText(data.description);
    var personality = cleanText(data.personality);
    var scenario = cleanText(data.scenario);
    var systemPrompt = cleanText(data.system_prompt);
    var mesExample = cleanText(data.mes_example);
    var postHistory = cleanText(data.post_history_instructions);
    var firstMes = cleanText(data.first_mes);
    var creatorNotes = cleanText(data.creator_notes);
    var extensions = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    var depthPrompt = cleanText(extensions.depth_prompt && extensions.depth_prompt.prompt);

    // Lorebooks have no home in PKAX yet. Always-on entries are folded
    // into the system prompt so they are not silently lost.
    var book = data.character_book || data.embedded_lorebook || null;
    var loreLines = [];
    if (book && Array.isArray(book.entries)) {
      for (var i = 0; i < book.entries.length && loreLines.length < 20; i++) {
        var entry = book.entries[i];
        if (!entry || typeof entry !== 'object') continue;
        var keys = Array.isArray(entry.keys) ? entry.keys : [];
        if (entry.constant || (entry.enabled !== false && keys.length === 0)) {
          var content = cleanText(entry.content);
          if (content) loreLines.push(content);
        }
      }
    }

    var parts = [];
    if (description) parts.push(description);
    if (personality && personality !== description) parts.push('Personality:\n' + personality);
    if (scenario) parts.push('Scenario:\n' + scenario);
    if (systemPrompt) parts.push(systemPrompt);
    if (mesExample) parts.push('Example dialogue:\n' + mesExample);
    if (postHistory) parts.push(postHistory);
    if (depthPrompt) parts.push(depthPrompt);
    if (loreLines.length) parts.push('Lorebook (always active):\n' + loreLines.join('\n\n'));

    var assembled = substitutePlaceholders(parts.join('\n\n'), name);

    var avatar = cleanText(data.avatar);
    if (!avatar || /^none$/i.test(avatar) || avatar.indexOf('__asset:') === 0) avatar = '';

    return {
      name: name,
      greeting: substitutePlaceholders(firstMes, name),
      systemPrompt: assembled,
      avatar: avatar,
      alternateGreetings: asList(data.alternate_greetings, false)
        .map(function (g) { return substitutePlaceholders(g, name); }),
      creatorNotes: creatorNotes,
      tags: asList(data.tags, true),
      creator: cleanText(data.creator || opts.creator),
      characterVersion: cleanText(data.character_version),
      source: cleanText(opts.source),
      lorebook: book
    };
  }

  /** `chub.ai/characters/<creator>/<project>` -> { creator, project }. */
  function parseChubUrl(input) {
    var s = String(input || '').trim();
    if (!s) return null;

    var m = s.match(
      /^(?:https?:\/\/)?(?:www\.)?(?:chub\.ai|characterhub\.org)\/characters\/([^/?#]+)\/([^/?#]+)/i
    );
    if (m) return { creator: m[1], project: m[2] };

    // Bare "creator/project" is also accepted, like SillyTavern does.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      var parts = s.split('/').filter(Boolean);
      if (parts.length === 2 && /^[\w-]+$/.test(parts[0]) && /^[\w-]+$/.test(parts[1])) {
        return { creator: parts[0], project: parts[1] };
      }
    }

    return null;
  }

  /**
   * Chub link -> card. Uses `?full=true`, whose `definition` is newer than
   * the copy embedded in the card PNG (the API also carries topics and the
   * avatar URL). Field mapping follows SillyTavern's downloadChubCharacter.
   */
  async function fetchChubCard(input) {
    var parsed = parseChubUrl(input);
    if (!parsed) throw new Error('That does not look like a Chub character link.');

    var url = 'https://api.chub.ai/api/characters/'
      + encodeURIComponent(parsed.creator) + '/'
      + encodeURIComponent(parsed.project) + '?full=true';

    var res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error('Chub returned HTTP ' + res.status + ' for that link.');
    }

    var metadata = await res.json();
    var node = metadata && metadata.node;
    var def = node && node.definition;
    if (!def) throw new Error('Chub did not return a character definition.');

    return normalizeCard({
      name: def.name || (node && node.name) || 'Imported Character',
      description: def.personality || '',
      personality: def.tavern_personality || '',
      scenario: def.scenario || '',
      first_mes: def.first_message || '',
      mes_example: def.example_dialogs || '',
      creator_notes: def.description || '',
      system_prompt: def.system_prompt || '',
      post_history_instructions: def.post_history_instructions || '',
      alternate_greetings: def.alternate_greetings || [],
      tags: (node && node.topics) || [],
      creator: parsed.creator,
      character_version: '',
      extensions: def.extensions || {},
      character_book: def.embedded_lorebook || null,
      avatar: def.avatar || (node && node.avatar_url) || ''
    }, { source: String(input || '').trim(), creator: parsed.creator });
  }

  /** URL -> card. Chub pages go through the API; anything else is fetched directly. */
  async function resolveUrl(input) {
    var s = String(input || '').trim();
    if (!s) throw new Error('Paste a link first.');

    if (!/^https?:\/\//i.test(s)) {
      if (parseChubUrl(s)) return fetchChubCard(s);
      throw new Error('Paste a full https:// link or a Chub creator/project.');
    }

    if (parseChubUrl(s)) return fetchChubCard(s);

    var res = await fetch(s, { headers: { Accept: 'application/json, image/png, image/*, */*' } });
    if (!res.ok) throw new Error('Could not fetch that URL (HTTP ' + res.status + ').');

    var buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FILE_BYTES) throw new Error('That file is larger than 15 MB.');
    return readCardBlob(buf, s);
  }

  /** File -> card. */
  async function resolveFile(file) {
    if (!file) throw new Error('Choose a file first.');
    var buf = await file.arrayBuffer();
    if (buf.byteLength > MAX_FILE_BYTES) throw new Error('That file is larger than 15 MB.');
    return readCardBlob(buf, file.name || '');
  }

  /** Bytes -> card. Detects PNG by signature, otherwise parses JSON. */
  async function readCardBlob(buf, name) {
    var bytes = new Uint8Array(buf);
    var isPng = bytes.length > 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

    if (isPng) {
      var raw = await extractCardFromPng(bytes);
      return normalizeCard(raw, { source: name });
    }

    var text = utf8(bytes).trim();
    if (text.charAt(0) === '\uFEFF') text = text.slice(1);
    if (text.charAt(0) === '{' || /\.json$/i.test(name || '')) {
      try {
        return normalizeCard(JSON.parse(text), { source: name });
      } catch (e) {
        throw new Error('That JSON file is not a valid character card.');
      }
    }

    throw new Error('That file is not a PNG character card or a JSON card.');
  }

  window.PKAXImport = {
    parseChubUrl: parseChubUrl,
    resolveUrl: resolveUrl,
    resolveFile: resolveFile,
    readCardBlob: readCardBlob,
    extractCardFromPng: extractCardFromPng,
    normalizeCard: normalizeCard,
    substitutePlaceholders: substitutePlaceholders
  };
})();
