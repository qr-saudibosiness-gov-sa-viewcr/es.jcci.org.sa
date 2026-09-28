(function () {
  'use strict';

  var root = (window.__UNIFIED_DEPLOYMENT_ROOT__ || '/');
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  var routesPromise = null;

  // Capture blank mode ONCE, before the Angular app can rewrite the URL/query string.
  // The root index loads the viewer with ?__blank=1, so the viewer must stay blank
  // even if the app later removes that query parameter from its internal URL.
  var forceBlank = false;
  try {
    forceBlank = new URLSearchParams(location.search).get('__blank') === '1';
  } catch (_) {}

  function rootUrl(relative) {
    return root.replace(/\/$/, '') + '/' + String(relative || '').replace(/^\/+/, '');
  }

  function currentToken() {
    var path = decodeURIComponent(location.pathname || '');
    var marker = '/files-portal/';
    var at = path.indexOf(marker);
    if (at < 0) return '';
    return path.slice(at + marker.length).replace(/\/+$/, '').split('/')[0];
  }

  function isDocumentApi(url) {
    return String(url || '').indexOf('ViewDocumentV2') !== -1;
  }

  function DocumentNotFoundError(message) {
    this.name = 'DocumentNotFoundError';
    this.message = message || 'Page not found.';
    if (Error.captureStackTrace) Error.captureStackTrace(this, DocumentNotFoundError);
  }
  DocumentNotFoundError.prototype = Object.create(Error.prototype);
  DocumentNotFoundError.prototype.constructor = DocumentNotFoundError;

  function showNotFoundPage() {
    if (window.__DOCUMENT_NOT_FOUND_SHOWN__) return;
    window.__DOCUMENT_NOT_FOUND_SHOWN__ = true;

    try {
      document.title = 'Error 404';
      document.documentElement.setAttribute('lang', 'en');
      document.documentElement.setAttribute('dir', 'ltr');

      var render = function () {
        if (!document.body) return;
        document.body.innerHTML = '';
        document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#111;';

        var page = document.createElement('div');
        page.id = 'document-not-found-page';
        page.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#fff;text-align:center;';
        page.innerHTML = '<div><div style="font-size:32px;line-height:1.15;font-weight:700;margin:0 0 8px;">Error 404</div><div style="font-size:14px;line-height:1.4;font-weight:400;color:#333;">Page not found.</div></div>';
        document.body.appendChild(page);
      };

      if (document.body) render();
      else document.addEventListener('DOMContentLoaded', render, { once: true });
    } catch (_) {}
  }

  function loadRoutes() {
    if (!routesPromise) {
      routesPromise = nativeFetch(rootUrl('data/routes.json'), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('routes.json HTTP ' + r.status); return r.json(); });
    }
    return routesPromise;
  }

  function bytesToBase64(bytes) {
    var binary = '';
    for (var offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
  }

  function pdfToContentList(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length < 5 || String.fromCharCode.apply(null, bytes.subarray(0, 5)) !== '%PDF-') {
      throw new Error('Invalid PDF file');
    }
    var base64 = bytesToBase64(bytes);
    var chunkSize = 94456; // Matches the captured viewer's normal payload size (3-char prefix + data).
    var chunks = [];
    for (var offset = 0, index = 0; offset < base64.length; offset += chunkSize, index++) {
      chunks.push(String(index).padStart(3, '0') + base64.slice(offset, offset + chunkSize));
    }
    return chunks;
  }

  function buildDocumentPayload() {
    if (!nativeFetch) return Promise.reject(new Error('fetch is unavailable'));
    var token = currentToken();
    return loadRoutes().then(function (routes) {
      var id = forceBlank ? '__blank__' : routes[token];
      if (!id) throw new DocumentNotFoundError('No document is mapped to token: ' + token);
      return Promise.all([
        nativeFetch(rootUrl('data/' + id + '.json'), { cache: 'no-store' }).then(function (r) {
          if (!r.ok) {
            if (r.status === 404) throw new DocumentNotFoundError(id + '.json HTTP 404');
            throw new Error(id + '.json HTTP ' + r.status);
          }
          return r.json();
        }),
        nativeFetch(rootUrl('data/' + id + '.pdf'), { cache: 'no-store' }).then(function (r) {
          if (!r.ok) {
            if (r.status === 404) throw new DocumentNotFoundError(id + '.pdf HTTP 404');
            throw new Error(id + '.pdf HTTP ' + r.status);
          }
          return r.arrayBuffer();
        })
      ]);
    }).then(function (parts) {
      var payload = parts[0];
      if (!payload.data) payload.data = {};
      payload.data.contentList = pdfToContentList(parts[1]);
      return payload;
    });
  }

  function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  if (nativeFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url;
      if (isDocumentApi(url)) {
        return buildDocumentPayload().then(jsonResponse).catch(function (error) {
          console.error('[document-router]', error);
          if (error && error.name === 'DocumentNotFoundError') showNotFoundPage();
          return new Response(JSON.stringify({ succeeded: false, message: String(error.message || error), errors: [String(error.message || error)], data: null }), {
            status: 404,
            headers: { 'content-type': 'application/json; charset=utf-8' }
          });
        });
      }
      return nativeFetch(input, init);
    };
  }

  var NativeXHR = window.XMLHttpRequest;
  if (NativeXHR) {
    function RoutedXHR() {
      var xhr = new NativeXHR();
      var requestedUrl = '';
      var requestedMethod = '';
      var open = xhr.open.bind(xhr);
      var send = xhr.send.bind(xhr);

      xhr.open = function (method, url) {
        requestedMethod = method;
        requestedUrl = String(url || '');
        return open.apply(xhr, arguments);
      };

      xhr.send = function (body) {
        if (!isDocumentApi(requestedUrl)) return send.call(xhr, body);
        buildDocumentPayload().then(function (payload) {
          var responseText = JSON.stringify(payload);
          Object.defineProperties(xhr, {
            readyState: { configurable: true, get: function () { return 4; } },
            status: { configurable: true, get: function () { return 200; } },
            statusText: { configurable: true, get: function () { return 'OK'; } },
            responseText: { configurable: true, get: function () { return responseText; } },
            response: { configurable: true, get: function () { return responseText; } },
            responseURL: { configurable: true, get: function () { return requestedUrl; } }
          });
          xhr.getAllResponseHeaders = function () { return 'content-type: application/json; charset=utf-8'; };
          xhr.getResponseHeader = function (name) {
            return String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
          };
          queueMicrotask(function () {
            if (xhr.onreadystatechange) xhr.onreadystatechange(new Event('readystatechange'));
            if (xhr.onload) xhr.onload(new Event('load'));
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new Event('load'));
          });
        }).catch(function (error) {
          console.error('[document-router]', error);
          if (error && error.name === 'DocumentNotFoundError') showNotFoundPage();
          var responseText = JSON.stringify({ succeeded: false, message: String(error.message || error), errors: [String(error.message || error)], data: null });
          Object.defineProperties(xhr, {
            readyState: { configurable: true, get: function () { return 4; } },
            status: { configurable: true, get: function () { return 404; } },
            statusText: { configurable: true, get: function () { return 'Not Found'; } },
            responseText: { configurable: true, get: function () { return responseText; } },
            response: { configurable: true, get: function () { return responseText; } }
          });
          queueMicrotask(function () {
            if (xhr.onreadystatechange) xhr.onreadystatechange(new Event('readystatechange'));
            if (xhr.onerror) xhr.onerror(new Event('error'));
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new Event('error'));
          });
        });
      };
      return xhr;
    }
    RoutedXHR.prototype = NativeXHR.prototype;
    Object.keys(NativeXHR).forEach(function (key) { try { RoutedXHR[key] = NativeXHR[key]; } catch (_) {} });
    window.XMLHttpRequest = RoutedXHR;
  }
})();
