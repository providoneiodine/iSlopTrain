/*
 * iSlopTrain core namespace + plugin registry.
 *
 * Everything is a classic <script> (no ES modules, no build step) so the app
 * runs straight from file:// as well as from any static server.
 *
 * A "drill" is a self-contained training module registered with
 * IST.registerDrill(). The app shell (menu, settings, results, history) is
 * generated from the drill definition, so new drills or alternative
 * interface variants can be added by dropping in one file.
 * See README.md -> "Adding a drill".
 */
(function () {
  'use strict';
  const IST = (window.IST = window.IST || {});
  IST.version = '0.1.0';
  IST.drills = [];
  IST.sessions = [];

  IST.registerDrill = function (def) {
    ['id', 'name', 'create'].forEach((k) => {
      if (!def[k]) throw new Error('Drill definition missing "' + k + '"');
    });
    if (IST.drills.some((d) => d.id === def.id)) throw new Error('Duplicate drill id ' + def.id);
    def.settings = def.settings || [];
    def.metrics = def.metrics || [];
    def.research = def.research || [];
    IST.drills.push(def);
    return def;
  };

  IST.getDrill = (id) => IST.drills.find((d) => d.id === id);

  IST.registerSession = function (def) {
    IST.sessions.push(def);
    return def;
  };

  IST.primaryMetric = (def) => def.metrics.find((m) => m.primary) || def.metrics[0];
})();
