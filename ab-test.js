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
 * https://github.com/RodriCU/ab-test
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
    var re = new RegExp('(?:^|; )' + name.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1') + '=([^;]*)');
    var match = re.exec(document.cookie);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function _setCookie(name, value, days) {
    var date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    var domain = location.hostname.replace(/^www\./, '');
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
   * Assigns a variant to a user for a given experiment.
   * Returns 'control' if the user is outside the traffic allocation,
   * or a variant name from the experiment.variants array.
   *
   * Assignment is DETERMINISTIC: same user + experiment always returns
   * the same variant. No backend call needed.
   */
  function _assignVariant(experiment, userId) {
    // Check if user already has a stored assignment for this experiment
    var cookieName = EXP_COOKIE_PREFIX + experiment.id;
    var stored = _getCookie(cookieName);
    if (stored) {
      _log('Experiment "' + experiment.id + '": using stored assignment → ' + stored);
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
      // Assign to one of the variants using a second hash for even distribution
      var variantIndex = _getBucket(userId, experiment.id + '_split') % variants.length;
      variant = variants[variantIndex];
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

  /**
   * Checks if the current user matches the audience rules of an experiment.
   * All specified conditions must pass (AND logic).
   * Returns true if no audience rules are defined.
   *
   * Supported audience rules:
   *   url: RegExp           — matches against current URL
   *   device: string|array  — 'mobile', 'tablet', 'desktop'
   *   utm_source: string    — exact match
   *   utm_medium: string    — exact match
   *   utm_campaign: string  — exact match
   *   cookie: { name, value } — exact match (omit value to check existence)
   *   dataLayer: { key, value } — checks first-level dataLayer for key/value
   *   dataLayerItems: { key, value } — checks ecommerce.items[] for key/value
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

    // UTM filters
    var utmParams = ['utm_source', 'utm_medium', 'utm_campaign'];
    for (var i = 0; i < utmParams.length; i++) {
      var param = utmParams[i];
      if (audience[param] !== undefined) {
        if (_getUTMParam(param) !== audience[param]) {
          _log('Experiment "' + experiment.id + '": skipped — ' + param + ' mismatch');
          return false;
        }
      }
    }

    // Cookie filter
    if (audience.cookie) {
      var cookieVal = _getCookie(audience.cookie.name);
      if (!cookieVal) {
        _log('Experiment "' + experiment.id + '": skipped — cookie "' + audience.cookie.name + '" not found');
        return false;
      }
      if (audience.cookie.value !== undefined && cookieVal !== audience.cookie.value) {
        _log('Experiment "' + experiment.id + '": skipped — cookie value mismatch');
        return false;
      }
    }

    // dataLayer filter (first level)
    if (audience.dataLayer) {
      var dlValue = _getDataLayerValue(audience.dataLayer.key);
      if (dlValue === null) {
        _log('Experiment "' + experiment.id + '": skipped — dataLayer key "' + audience.dataLayer.key + '" not found');
        return false;
      }
      if (audience.dataLayer.value !== undefined && dlValue !== audience.dataLayer.value) {
        _log('Experiment "' + experiment.id + '": skipped — dataLayer value mismatch');
        return false;
      }
    }

    // dataLayerItems filter (ecommerce.items[])
    if (audience.dataLayerItems) {
      var dlItemsValue = _getDataLayerItemsValue(audience.dataLayerItems.key);
      if (dlItemsValue === null) {
        _log('Experiment "' + experiment.id + '": skipped — dataLayer items key "' + audience.dataLayerItems.key + '" not found');
        return false;
      }
      if (audience.dataLayerItems.value !== undefined && String(dlItemsValue) !== String(audience.dataLayerItems.value)) {
        _log('Experiment "' + experiment.id + '": skipped — dataLayer items value mismatch');
        return false;
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
  // EXPERIMENT RUNNER
  // ─────────────────────────────────────────────

  function _runExperiment(experiment, userId) {
    if (!experiment.id) {
      _warn('Experiment missing required field "id". Skipping.');
      return;
    }

    // Check audience targeting
    if (!_matchAudience(experiment)) return;

    // Assign variant
    var variant = _assignVariant(experiment, userId);
    if (variant === null) return; // User not in experiment traffic

    // Apply DOM changes
    if (experiment.changes && typeof experiment.changes[variant] === 'function') {
      try {
        experiment.changes[variant]();
      } catch (e) {
        _warn('Error running changes for variant "' + variant + '" in experiment "' + experiment.id + '": ' + e.message);
      }
    }

    // Push to GA4 dataLayer
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

      // Apply DOM changes only once the DOM is ready, but keep body hidden
      // until all changes are done — this is true anti-flicker with no fixed timeout
      function _applyAll() {
        for (var i = 0; i < experiments.length; i++) {
          _runExperiment(experiments[i], userId);
        }
        _showBody();
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _applyAll);
      } else {
        // DOM already ready (e.g. script loaded async or placed at bottom)
        _applyAll();
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
        document.cookie = EXP_COOKIE_PREFIX + experiments[i].id + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      }
      document.cookie = USER_COOKIE + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      _log('All experiment cookies cleared.');
    }
  };

  // Auto-initialize
  ABTest.init();

  // Expose public API
  window.ABTest = ABTest;

})();
