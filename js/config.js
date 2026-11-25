/*
 * Site settings that differ per deployment. Optional: left empty, the app works as it is.
 *
 *   esriKey: an ArcGIS API key for the satellite imagery, restricted to this site's address and to
 *            basemaps only, so it's safe to publish. With it, tiles come from Esri's keyed service
 *            (counted against that account's free allowance) instead of the public one.
 */
(function () {
  'use strict';
  IST.CONFIG = Object.assign({ esriKey: 'AAPTa7M9yspwKMbsYig_F6XqqWg..Vvt9KCNzhnhIRWxOHHC0lW2qjm2ku6MlGncnof5yk_EBh370hBRRsa10NSiW6WqZItiojvqKLvV1Q3OGLE3rnuWuW7gql8J5TfZIgb5A2r9XAeXQHttZrro6JuQ7t5JpCDhDKHxj7LCf6G6BxPIhh1jtICVAgmZJiPvaWGv8fT_PcSQ43Sc0giYpXwZQdcBRQOQPw-R5k1d2lzwrnnch3fkNhXDCTWOppF6zZdRq2RqBlWG3LoHLAT1_irrnGmTH' }, IST.CONFIG);
})();
