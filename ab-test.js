/**
 * ab-test.js — Free A/B Testing Library
 * Version: 2.0.0
 *
 * 100% client-side, no backend required.
 * Deterministic variant assignment via hash — no rate limits, infinitely scalable.
 * GA4/dataLayer integration compatible with GTM.
 *
 * Usage:
 *   1. Define window.ABTestConfig BEFORE loading this script
 *   2. Add <script src="ab-test.js"></script> in <head> (as early as possible)
 *   3. That's it. No PHP, no APIs, no Google Sheets.
 *
 * https://github.com/RodriCU/test-ab-tool
 */

(function () {
  'use strict';

  // ─────────────────────────────────────────────
  // CONFIG
  // ─────────────────────────────────────────────

  var config = window.ABTestConfig || {};
  var DEBUG = config.debug === true;
  var COOKIE_DAYS = config.cookieDays || 90;
  var USER_COOKIE = '_ab_uid';
  var EXP_COOKIE_PREFIX = '_ab_';

  // ─────────────────────────────────────────────
  // UTILS — COOKIES
  // ─────────────────────────────────────────────

  function _getCookie(name) {
    // localStorage first — works on file:// and when cookies are blocked
    try {
      var lsVal = localStorage.getItem(name);
      if (lsVal !== null) return lsVal;
    } catch (e) {}
    var re = new RegExp('(?:^|; )' + name.replace(/([.*+?^=!:${}()|[]/\])/g, '\$1') + '=([^;]*)');
    var match = re.exec(document.cookie);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function _setCookie(name, value, days) {
    // localStorage — works on file:// and is the primary persistence layer
    try { localStorage.setItem(name, value); } catch (e) {}
    // Cookie — for cross-subdomain support in production
    var date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    var domain = location.hostname.replace(/^www./, '');
    document.cookie = name + '=' + encodeURIComponent(value) +
      '; expires=' + date.toUTCString() +
      '; path=/' +
      (domain ? '; domain=.' + domain : '');
  }

  // ─────────────────────────────────────────────
  // CORE — USER ID & HASH
  // ─────────────────────────────────────────────

  function _generateUserId() {
    var existing = _getCookie(USER_COOKIE);
    if (existing) return existing;
    // Generate a random unique ID
    var id = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    _setCookie(USER_COOKIE, id, 365);
    return id;
  }

  /**
   * djb2 hash — fast, well-distributed, deterministic
   * Returns an integer 0–99 (bucket) for a given userId + experimentId combo.
   */
  function _getBucket(userId, experimentId) {
    var str = userId + '|' + experimentId;
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // convert to 32-bit int
    }
    return Math.abs(hash) % 100;
  }

  /**
   * Assigns a variant based on weighted distribution.
   * bucket: integer 0–99 (from _getBucket)
   * weights: array of numbers (e.g. [50, 50] or [60, 40]). Auto-normalized.
   */
  function _assignVariantByWeight(bucket, variants, weights) {
    var total = 0;
    for (var i = 0; i < weights.length; i++) total += weights[i];
    var cursor = 0;
    for (var i = 0; i < variants.length; i++) {
      cursor += (weights[i] / total) * 100;
      if (bucket < cursor) return variants[i];
    }
    return variants[variants.length - 1];
  }

  /**
   * Assigns a variant to a user for a given experiment.
   * Returns null if the user is outside the traffic allocation.
   * Assignment is DETERMINISTIC: same user + experiment always returns
   * the same variant. No backend call needed.
   *
   * Optional experiment.weights array (e.g. [60, 40]) controls the split
   * between variants. Defaults to equal distribution if omitted.
   */
  function _assignVariant(experiment, userId) {
    var cookieName = EXP_COOKIE_PREFIX + experiment.id;

    // ── Modo debug: forzar variante mediante parámetro de URL ──────────
    // Uso: añadir ?_ab_EXPERIMENT_ID=variant_a a la URL (solo funciona con debug:true)
    if (DEBUG) {
      try {
        var forcedVariant = new URLSearchParams(location.search).get('_ab_' + experiment.id);
        if (forcedVariant) {
          var validVariants = experiment.variants || ['control', 'variant_a'];
          if (validVariants.indexOf(forcedVariant) !== -1) {
            _log('Experiment "' + experiment.id + '": variante FORZADA por URL → ' + forcedVariant);
            _setCookie(cookieName, forcedVariant, COOKIE_DAYS);
            return forcedVariant;
          } else {
            _warn('Experiment "' + experiment.id + '": variante forzada "' + forcedVariant + '" no válida. Valores posibles: ' + validVariants.join(', '));
          }
        }
      } catch (e) {}
    }

    // Check if user already has a stored assignment for this experiment
    var stored = _getCookie(cookieName);
    if (stored) {
      _log('Experiment "' + experiment.id + '": asignación en caché → ' + stored);
      return stored;
    }

    var bucket = _getBucket(userId, experiment.id);
    var traffic = Math.round((experiment.traffic || 0.5) * 100); // e.g. 0.5 → 50
    var variants = experiment.variants || ['control', 'variant_a'];

    var variant;
    if (bucket >= traffic) {
      // User is outside the traffic allocation — not in the experiment
      variant = null;
    } else {
      var splitBucket = _getBucket(userId, experiment.id + '_split');
      // Use weights if provided, otherwise equal split
      if (experiment.weights && experiment.weights.length === variants.length) {
        variant = _assignVariantByWeight(splitBucket, variants, experiment.weights);
      } else {
        variant = variants[splitBucket % variants.length];
      }
    }

    if (variant !== null) {
      _setCookie(cookieName, variant, COOKIE_DAYS);
      _log('Experiment "' + experiment.id + '": new assignment → ' + variant + ' (bucket=' + bucket + ', traffic=' + traffic + ')');
    } else {
      _log('Experiment "' + experiment.id + '": user outside traffic allocation (bucket=' + bucket + ', traffic=' + traffic + ')');
    }

    return variant;
  }

  // ─────────────────────────────────────────────
  // AUDIENCE TARGETING
  // ─────────────────────────────────────────────

  function _getDevice() {
    var ua = navigator.userAgent || navigator.vendor || window.opera;
    if (/android/i.test(ua)) return 'mobile';
    if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) return 'mobile';
    if (/iPad|Tablet|PlayBook|Nexus 7|Nexus 10/.test(ua)) return 'tablet';
    return 'desktop';
  }

  function _getUTMParam(param) {
    try {
      return new URLSearchParams(window.location.search).get(param) || null;
    } catch (e) {
      // Fallback for IE
      var match = new RegExp('[?&]' + param + '=([^&]*)').exec(window.location.search);
      return match ? decodeURIComponent(match[1]) : null;
    }
  }

  function _getDataLayerValue(key) {
    if (typeof window.dataLayer === 'undefined') return null;
    for (var i = 0; i < window.dataLayer.length; i++) {
      if (window.dataLayer[i].hasOwnProperty(key)) {
        return window.dataLayer[i][key];
      }
    }
    return null;
  }

  function _getDataLayerItemsValue(key) {
    if (typeof window.dataLayer === 'undefined') return null;
    for (var i = 0; i < window.dataLayer.length; i++) {
      var entry = window.dataLayer[i];
      if (entry.ecommerce && Array.isArray(entry.ecommerce.items)) {
        for (var j = 0; j < entry.ecommerce.items.length; j++) {
          if (entry.ecommerce.items[j].hasOwnProperty(key)) {
            return entry.ecommerce.items[j][key];
          }
        }
      }
    }
    return null;
  }

  function _getRawLocalStorage(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function _getRawSessionStorage(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }

  /**
   * Checks if the current user matches the audience rules of an experiment.
   * All specified conditions must pass (AND logic).
   * Returns true if no audience rules are defined.
   *
   * Supported audience rules:
   *   url: RegExp|string         — regex match against current URL
   *   device: string|array       — 'mobile', 'tablet', 'desktop'
   *   utm_source: RegExp|string  — regex match against UTM source
   *   utm_medium: RegExp|string  — regex match against UTM medium
   *   utm_campaign: RegExp|string — regex match against UTM campaign
   *   cookie: { name, value? }        — checks cookie; value is regex
   *   dataLayer: { key, value? }      — checks first-level dataLayer; value is regex
   *   dataLayerItems: { key, value? } — checks ecommerce.items[]; value is regex
   *   localStorage: { key, value? }   — checks localStorage key; value is regex
   *   sessionStorage: { key, value? } — checks sessionStorage key; value is regex
   */
  function _matchAudience(experiment) {
    var audience = experiment.audience;
    if (!audience) return true;

    // URL filter
    if (audience.url) {
      var urlPattern = audience.url instanceof RegExp ? audience.url : new RegExp(audience.url);
      if (!urlPattern.test(location.href)) {
        _log('Experiment "' + experiment.id + '": skipped — URL mismatch');
        return false;
      }
    }

    // Device filter
    if (audience.device) {
      var allowedDevices = Array.isArray(audience.device) ? audience.device : [audience.device];
      if (allowedDevices.indexOf(_getDevice()) === -1) {
        _log('Experiment "' + experiment.id + '": skipped — device mismatch (' + _getDevice() + ')');
        return false;
      }
    }

    // UTM filters (regex match)
    var utmParams = ['utm_source', 'utm_medium', 'utm_campaign'];
    for (var i = 0; i < utmParams.length; i++) {
      var param = utmParams[i];
      if (audience[param] !== undefined) {
        var utmPattern = audience[param] instanceof RegExp ? audience[param] : new RegExp(audience[param]);
        if (!utmPattern.test(_getUTMParam(param) || '')) {
          _log('Experiment "' + experiment.id + '": skipped — ' + param + ' mismatch');
          return false;
        }
      }
    }

    // Cookie filter (value is regex)
    if (audience.cookie) {
      var cookieVal = _getCookie(audience.cookie.name);
      if (!cookieVal) {
        _log('Experiment "' + experiment.id + '": skipped — cookie "' + audience.cookie.name + '" not found');
        return false;
      }
      if (audience.cookie.value !== undefined) {
        var cookiePattern = audience.cookie.value instanceof RegExp ? audience.cookie.value : new RegExp(audience.cookie.value);
        if (!cookiePattern.test(cookieVal)) {
          _log('Experiment "' + experiment.id + '": skipped — cookie value mismatch');
          return false;
        }
      }
    }

    // dataLayer filter (first level, value is regex)
    if (audience.dataLayer) {
      var dlValue = _getDataLayerValue(audience.dataLayer.key);
      if (dlValue === null) {
        _log('Experiment "' + experiment.id + '": skipped — dataLayer key "' + audience.dataLayer.key + '" not found');
        return false;
      }
      if (audience.dataLayer.value !== undefined) {
        var dlPattern = audience.dataLayer.value instanceof RegExp ? audience.dataLayer.value : new RegExp(audience.dataLayer.value);
        if (!dlPattern.test(String(dlValue))) {
          _log('Experiment "' + experiment.id + '": skipped — dataLayer value mismatch');
          return false;
        }
      }
    }

    // dataLayerItems filter (ecommerce.items[], value is regex)
    if (audience.dataLayerItems) {
      var dlItemsValue = _getDataLayerItemsValue(audience.dataLayerItems.key);
      if (dlItemsValue === null) {
        _log('Experiment "' + experiment.id + '": skipped — dataLayer items key "' + audience.dataLayerItems.key + '" not found');
        return false;
      }
      if (audience.dataLayerItems.value !== undefined) {
        var dlItemsPattern = audience.dataLayerItems.value instanceof RegExp ? audience.dataLayerItems.value : new RegExp(audience.dataLayerItems.value);
        if (!dlItemsPattern.test(String(dlItemsValue))) {
          _log('Experiment "' + experiment.id + '": skipped — dataLayer items value mismatch');
          return false;
        }
      }
    }

    // localStorage filter (value is regex)
    if (audience.localStorage) {
      var lsVal = _getRawLocalStorage(audience.localStorage.key);
      if (lsVal === null) {
        _log('Experiment "' + experiment.id + '": skipped — localStorage key "' + audience.localStorage.key + '" not found');
        return false;
      }
      if (audience.localStorage.value !== undefined) {
        var lsPattern = audience.localStorage.value instanceof RegExp ? audience.localStorage.value : new RegExp(audience.localStorage.value);
        if (!lsPattern.test(lsVal)) {
          _log('Experiment "' + experiment.id + '": skipped — localStorage value mismatch');
          return false;
        }
      }
    }

    // sessionStorage filter (value is regex)
    if (audience.sessionStorage) {
      var ssVal = _getRawSessionStorage(audience.sessionStorage.key);
      if (ssVal === null) {
        _log('Experiment "' + experiment.id + '": skipped — sessionStorage key "' + audience.sessionStorage.key + '" not found');
        return false;
      }
      if (audience.sessionStorage.value !== undefined) {
        var ssPattern = audience.sessionStorage.value instanceof RegExp ? audience.sessionStorage.value : new RegExp(audience.sessionStorage.value);
        if (!ssPattern.test(ssVal)) {
          _log('Experiment "' + experiment.id + '": skipped — sessionStorage value mismatch');
          return false;
        }
      }
    }

    return true;
  }

  // ─────────────────────────────────────────────
  // ANTI-FLICKER
  // ─────────────────────────────────────────────

  var _flickerStyle = null;

  function _hideBody() {
    // Only hide if we have experiments to run
    if (!config.experiments || config.experiments.length === 0) return;
    _flickerStyle = document.createElement('style');
    _flickerStyle.id = '_ab_flicker';
    _flickerStyle.innerHTML = 'body{visibility:hidden!important}';
    var head = document.head || document.getElementsByTagName('head')[0];
    if (head) head.insertBefore(_flickerStyle, head.firstChild);
  }

  function _showBody() {
    if (_flickerStyle && _flickerStyle.parentNode) {
      _flickerStyle.parentNode.removeChild(_flickerStyle);
      _flickerStyle = null;
    }
  }

  // ─────────────────────────────────────────────
  // TRACKING — GA4 / DATA LAYER
  // ─────────────────────────────────────────────

  function _pushDataLayer(experiment, variant, userId) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'exp_impression',
      experiment_name: experiment.name || experiment.id,
      experiment_id: experiment.id,
      experiment_variant: variant,
      experiment_type: experiment.type || 'ab_test',
      experiment_user_id: userId
    });
    _log('dataLayer push: exp_impression — ' + experiment.id + ' / ' + variant);
  }

  // ─────────────────────────────────────────────
  // SERVER-SIDE CONTROLLED ASSIGNMENT
  // ─────────────────────────────────────────────

  /**
   * Para cada experimento sin asignación en caché, llama al servidor
   * (ab-assign) para obtener una variante con distribución controlada
   * (split 50/50 garantizado en base de datos, no basado en el azar).
   *
   * Visitantes recurrentes: respuesta instantánea desde localStorage.
   * Visitantes nuevos: una llamada fetch, luego se cachea en localStorage.
   *
   * Si el servidor falla → fallback automático al hash local (sin pérdida de datos).
   */
  function _resolveServerAssignments(experiments, userId, assignUrl, workspaceId, callback) {
    var pending = [];

    for (var i = 0; i < experiments.length; i++) {
      var exp = experiments[i];
      // Excluir si la audiencia no aplica
      if (!_matchAudience(exp)) continue;
      // Excluir si ya tiene asignación cacheada
      if (_getCookie(EXP_COOKIE_PREFIX + exp.id)) continue;
      // Excluir si fuera del % de tráfico (determinístico, mismo resultado siempre)
      var bucket  = _getBucket(userId, exp.id);
      var traffic = Math.round((exp.traffic || 0.5) * 100);
      if (bucket >= traffic) continue;

      pending.push(exp);
    }

    if (pending.length === 0) {
      _log('Server assignment: all resolved from cache.');
      callback();
      return;
    }

    _log('Server assignment: fetching ' + pending.length + ' experiment(s)...');

    var done = 0;
    function onDone() {
      if (++done >= pending.length) callback();
    }

    for (var j = 0; j < pending.length; j++) {
      (function (exp) {
        _fetchAssignment(assignUrl, workspaceId, exp.id, userId, function (variant) {
          if (variant) {
            _setCookie(EXP_COOKIE_PREFIX + exp.id, variant, COOKIE_DAYS);
            _log('Server assignment "' + exp.id + '": ' + variant);
          } else {
            _log('Server assignment "' + exp.id + '": no variant returned, using local hash fallback.');
          }
          onDone();
        });
      })(pending[j]);
    }
  }

  /**
   * Llama al endpoint ab-assign para obtener la variante del servidor.
   * En caso de error de red llama callback(null) para que el hash local tome el relevo.
   */
  function _fetchAssignment(assignUrl, workspaceId, experimentId, userId, callback) {
    try {
      fetch(assignUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId:  workspaceId,
          experimentId: experimentId,
          userId:       userId
        })
      })
      .then(function (r) { return r.json(); })
      .then(function (data) { callback(data && data.variant ? data.variant : null); })
      .catch(function () {
        _warn('Server assignment fetch failed for "' + experimentId + '". Falling back to local hash.');
        callback(null);
      });
    } catch (e) {
      _warn('fetch() not available for "' + experimentId + '". Falling back to local hash.');
      callback(null);
    }
  }

  // ─────────────────────────────────────────────
  // EXPERIMENT RUNNER
  // ─────────────────────────────────────────────

  function _runExperiment(experiment, userId) {
    if (!experiment.id) {
      _warn('Experiment missing required field "id". Skipping.');
      return;
    }

    var type = experiment.type || 'ab_test';

    // ── Split URL ──────────────────────────────────────────────────────
    if (type === 'split_url') {
      // source_url es obligatorio — sin él el experimento correría en todas las páginas
      if (!experiment.source_url) {
        _warn('Experiment "' + experiment.id + '" (split_url): source_url no configurado. Experimento omitido.');
        return;
      }
      var srcPat = experiment.source_url instanceof RegExp
        ? experiment.source_url : new RegExp(experiment.source_url);
      if (!srcPat.test(location.href)) {
        _log('Experiment "' + experiment.id + '" (split_url): URL no coincide — omitido');
        return;
      }

      var splitVariant = _assignVariant(experiment, userId);
      if (splitVariant === null) {
        _log('Experiment "' + experiment.id + '" (split_url): usuario fuera del tráfico — omitido');
        return;
      }

      _log('Experiment "' + experiment.id + '" (split_url): variante asignada → ' + splitVariant);

      // Solo redirige (y trackea) cuando la variante no es control
      // El grupo control permanece en la página sin push al dataLayer
      if (splitVariant !== experiment.variants[0]) {
        if (!experiment.destination_url) {
          _warn('Experiment "' + experiment.id + '" (split_url): destination_url no configurado. Sin redirección.');
          return;
        }
        _pushDataLayer(experiment, splitVariant, userId);
        window.location.replace(experiment.destination_url);
      } else {
        _log('Experiment "' + experiment.id + '" (split_url): grupo control — sin redirección');
      }
      return;
    }

    // ── Ad Personalization ─────────────────────────────────────────────
    if (type === 'ad_personalization') {
      if (!experiment.rules || !experiment.rules.length) {
        _warn('Experiment "' + experiment.id + '" (ad_personalization): sin reglas configuradas.');
        return;
      }

      // Assign variant (controls the control/variant_a split)
      var adVariant = _assignVariant(experiment, userId);
      if (adVariant === null) {
        _log('Experiment "' + experiment.id + '" (ad_personalization): usuario fuera del tráfico — omitido');
        return;
      }
      // Control group: no personalization applied
      if (adVariant === experiment.variants[0]) {
        _log('Experiment "' + experiment.id + '" (ad_personalization): grupo control — sin cambios');
        return;
      }

      _log('Experiment "' + experiment.id + '" (ad_personalization): variante → ' + adVariant + ' — evaluando reglas');

      // Variant group: apply UTM-based rules
      var personalized = false;
      var utmKeys = ['utm_source', 'utm_medium', 'utm_campaign'];
      for (var r = 0; r < experiment.rules.length; r++) {
        var rule = experiment.rules[r];

        // Una regla sin ningún UTM configurado coincidiría con cualquier visita.
        // Si el experimento tiene source_url también, se puede usar para restringir la URL.
        var hasAnyUtm = rule.utm_source || rule.utm_medium || rule.utm_campaign;
        if (!hasAnyUtm) {
          _log('Experiment "' + experiment.id + '" (ad_personalization): regla ' + r + ' sin UTMs — se aplica a todas las visitas en variante');
        }

        var ruleOk = true;
        for (var k = 0; k < utmKeys.length; k++) {
          var utmKey = utmKeys[k];
          if (rule[utmKey]) {
            var utmPat = rule[utmKey] instanceof RegExp ? rule[utmKey] : new RegExp(rule[utmKey]);
            var utmVal = _getUTMParam(utmKey) || '';
            if (!utmPat.test(utmVal)) {
              _log('Experiment "' + experiment.id + '": regla ' + r + ' — ' + utmKey + ' "' + utmVal + '" no coincide con ' + rule[utmKey]);
              ruleOk = false;
              break;
            }
          }
        }
        if (!ruleOk) continue;

        if (rule.element_id) {
          try {
            var domEl = document.getElementById(rule.element_id);
            if (domEl) {
              domEl.textContent = rule.text || '';
              personalized = true;
              _log('Ad personalization "' + experiment.id + '": reemplazado #' + rule.element_id + ' → "' + rule.text + '"');
            } else {
              _warn('Ad personalization "' + experiment.id + '": elemento #' + rule.element_id + ' NO encontrado en el DOM');
            }
          } catch (e) {
            _warn('Ad personalization error en "' + experiment.id + '": ' + e.message);
          }
        }
      }
      if (personalized) _pushDataLayer(experiment, adVariant, userId);
      return;
    }

    // ── A/B Test (default) ─────────────────────────────────────────────
    if (!_matchAudience(experiment)) return;

    var variant = _assignVariant(experiment, userId);
    if (variant === null) return; // User not in experiment traffic

    if (experiment.changes && typeof experiment.changes[variant] === 'function') {
      try {
        experiment.changes[variant]();
      } catch (e) {
        _warn('Error running changes for variant "' + variant + '" in experiment "' + experiment.id + '": ' + e.message);
      }
    }

    _pushDataLayer(experiment, variant, userId);
  }

  // ─────────────────────────────────────────────
  // LOGGING
  // ─────────────────────────────────────────────

  function _log(msg) {
    if (DEBUG) console.log('[ABTest]', msg);
  }

  function _warn(msg) {
    console.warn('[ABTest]', msg);
  }

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────

  var ABTest = {
    /**
     * Initialize the A/B testing library.
     * Called automatically on script load.
     * Can also be called manually: ABTest.init()
     */
    init: function () {
      var experiments = config.experiments;
      if (!experiments || experiments.length === 0) {
        _log('No experiments configured. Done.');
        return;
      }

      // Hide body immediately (runs in <head>, before <body> is parsed)
      _hideBody();

      var userId = _generateUserId();
      _log('User ID: ' + userId);

      // Apply DOM changes once DOM is ready; body stays hidden until done (anti-flicker)
      function _applyAll() {
        for (var i = 0; i < experiments.length; i++) {
          _runExperiment(experiments[i], userId);
        }
        _showBody();
      }

      function _scheduleApply() {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', _applyAll);
        } else {
          _applyAll();
        }
      }

      // Si el config incluye assignUrl (inyectado por super-api),
      // se usa asignación controlada servidor; si no, hash local.
      if (config.assignUrl && config.workspaceId) {
        _log('Server-side assignment mode (controlled split).');
        _resolveServerAssignments(experiments, userId, config.assignUrl, config.workspaceId, _scheduleApply);
      } else {
        _log('Local hash assignment mode.');
        _scheduleApply();
      }
    },

    /**
     * Get the assigned variant for a specific experiment.
     * Useful for conditional logic outside the changes function.
     *
     * @param {string} experimentId
     * @returns {string|null} variant name or null if not assigned
     */
    getVariant: function (experimentId) {
      return _getCookie(EXP_COOKIE_PREFIX + experimentId);
    },

    /**
     * Get the current user ID.
     * @returns {string}
     */
    getUserId: function () {
      return _getCookie(USER_COOKIE);
    },

    /**
     * Reset all experiment assignments for the current user.
     * Useful for testing. Do NOT call in production.
     */
    reset: function () {
      var experiments = config.experiments || [];
      for (var i = 0; i < experiments.length; i++) {
        var cName = EXP_COOKIE_PREFIX + experiments[i].id;
        document.cookie = cName + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        try { localStorage.removeItem(cName); } catch (e) {}
      }
      document.cookie = USER_COOKIE + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      try { localStorage.removeItem(USER_COOKIE); } catch (e) {}
      _log('All experiment assignments cleared.');
    }
  };

  // Auto-initialize
  ABTest.init();

  // Expose public API
  window.ABTest = ABTest;

})();
