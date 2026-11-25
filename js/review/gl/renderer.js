/*
 * A minimal WebGL renderer for the Review viewer: one shader, interleaved
 * vertex buffers, a draw list. No scene graph and no dependencies.
 *
 *   const R = IST.Review.GL.create(canvas)     null if WebGL isn't available
 *   R.mesh(mode, data)        upload; mode 'tris' | 'strip' | 'lines' | 'linestrip';
 *                             data: Float32Array of [x y z  nx ny nz  r g b a] per vertex
 *   R.free(mesh)
 *   R.texture(image)          upload an image (power-of-two sides: mipmapped)
 *   R.texMesh(mode, data)     a textured mesh: [x y z  u v] per vertex
 *   R.draw(viewProj, eye, items, fog)  items: [{ mesh, lit, blend, depth, lift }]
 *                             or { mesh (texMesh), tex, tint ([r g b]), lift }: drawn
 *                             first, opaque, unlit (the satellite ground)
 *   R.resize()                match the canvas to its CSS size x devicePixelRatio
 *   R.destroy()
 *
 * lit: 0 flat colour, 1 lit by a fixed sun (so slopes read as shape).
 * blend: alpha-blend and don't write depth (fences). lift: polygon offset so
 * lines drawn on the road win the depth test. xray: { mesh, alpha }: where this
 * opaque mesh hides that one, draw it faint instead (the cars' passthru).
 * GL.Verts() is a growable vertex list, so Scene writes plain geometry;
 * V.reset() empties one for reuse.
 */
(function () {
  'use strict';
  IST.Review = IST.Review || {};
  const STRIDE = 10;

  const VS = [
    'attribute vec3 aPos; attribute vec3 aNrm; attribute vec4 aCol;',
    'uniform mat4 uVP; uniform vec3 uEye; uniform float uLit; uniform vec2 uFog;',
    'varying vec4 vCol; varying float vFog;',
    'void main() {',
    '  vec3 L = normalize(vec3(0.35, 0.85, 0.4));',
    '  float d = max(dot(normalize(aNrm), L), 0.0);',
    '  float k = mix(1.0, 0.5 + 0.6 * d, uLit);',
    '  vCol = vec4(aCol.rgb * k, aCol.a);',
    '  vFog = clamp((distance(aPos, uEye) - uFog.x) / max(1.0, uFog.y - uFog.x), 0.0, 0.85);',
    '  gl_Position = uVP * vec4(aPos, 1.0);',
    '}',
  ].join('\n');
  const FS = [
    'precision mediump float;',
    'uniform vec3 uFogCol; uniform float uAlpha; varying vec4 vCol; varying float vFog;',
    'void main() { gl_FragColor = vec4(mix(vCol.rgb, uFogCol, vFog), vCol.a * uAlpha); }',
  ].join('\n');

  // textured ground: the image, tinted, with the same fog
  const TVS = [
    'attribute vec3 aPos; attribute vec2 aUV;',
    'uniform mat4 uVP; uniform vec3 uEye; uniform vec2 uFog;',
    'varying vec2 vUV; varying float vFog;',
    'void main() {',
    '  vUV = aUV;',
    '  vFog = clamp((distance(aPos, uEye) - uFog.x) / max(1.0, uFog.y - uFog.x), 0.0, 0.85);',
    '  gl_Position = uVP * vec4(aPos, 1.0);',
    '}',
  ].join('\n');
  const TFS_PLAIN = [
    'precision mediump float;',
    'uniform sampler2D uTex; uniform vec3 uTint; uniform vec3 uFogCol; varying vec2 vUV; varying float vFog;',
    'void main() { vec3 c = texture2D(uTex, vUV).rgb * uTint; gl_FragColor = vec4(mix(c, uFogCol, vFog), 1.0); }',
  ].join('\n');
  // The same, getting more out of the imagery (needs OES_standard_derivatives to know
  // how big an image pixel is on screen; tiles are 256 px):
  //  - drawn bigger than its pixels (zoomed right in): Catmull-Rom (bicubic) instead of
  //    bilinear, so edges stay crisp instead of blocky or mushy;
  //  - near 1:1: a mild unsharp mask, faded out as the image shrinks, where it would
  //    only add shimmer. Neither adds detail that isn't there.
  const TFS = [
    '#extension GL_OES_standard_derivatives : enable',
    'precision highp float;',
    'uniform sampler2D uTex; uniform vec3 uTint; uniform vec3 uFogCol; varying vec2 vUV; varying float vFog;',
    'const float T = 256.0;',
    'vec3 tap(vec2 p) { return texture2D(uTex, p / T).rgb; }',
    'vec3 bicubic(vec2 uv) {',
    '  vec2 sp = uv * T, t1 = floor(sp - 0.5) + 0.5, f = sp - t1;',
    '  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);',
    '  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);',
    '  vec2 w12 = w1 + w2, t12 = t1 + w2 / w12, t0 = t1 - 1.0, t3 = t1 + 2.0;',
    '  vec3 r0 = tap(vec2(t0.x, t0.y)) * w0.x + tap(vec2(t12.x, t0.y)) * w12.x + tap(vec2(t3.x, t0.y)) * w3.x;',
    '  vec3 r1 = tap(vec2(t0.x, t12.y)) * w0.x + tap(vec2(t12.x, t12.y)) * w12.x + tap(vec2(t3.x, t12.y)) * w3.x;',
    '  vec3 r2 = tap(vec2(t0.x, t3.y)) * w0.x + tap(vec2(t12.x, t3.y)) * w12.x + tap(vec2(t3.x, t3.y)) * w3.x;',
    '  return r0 * w0.y + r1 * w12.y + r2 * w3.y;',
    '}',
    'void main() {',
    '  float fp = max(length(dFdx(vUV)), length(dFdy(vUV))) * T;', // image pixels per screen pixel
    '  vec3 plain = texture2D(uTex, vUV).rgb;',
    '  vec3 c = mix(bicubic(vUV), plain, smoothstep(0.6, 1.0, fp));',
    '  vec2 o = vec2(1.0 / T, 0.0);',
    '  vec3 blur = 0.25 * (texture2D(uTex, vUV + o).rgb + texture2D(uTex, vUV - o).rgb + texture2D(uTex, vUV + o.yx).rgb + texture2D(uTex, vUV - o.yx).rgb);',
    '  c += 0.45 * (1.0 - smoothstep(0.8, 1.8, fp)) * (plain - blur);',
    '  c = clamp(c, 0.0, 1.0) * uTint;',
    '  gl_FragColor = vec4(mix(c, uFogCol, vFog), 1.0);',
    '}',
  ].join('\n');
  const TSTRIDE = 5;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function create(canvas) {
    const gl = canvas.getContext && (canvas.getContext('webgl', { antialias: true, alpha: false, stencil: true }) || canvas.getContext('experimental-webgl'));
    if (!gl) return null;
    const link = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    };
    const prog = link(VS, FS);
    let tprog, sharp = true;
    try {
      if (!gl.getExtension('OES_standard_derivatives')) throw new Error('no derivatives');
      tprog = link(TVS, TFS);
    } catch (e) {
      tprog = link(TVS, TFS_PLAIN);
      sharp = false;
    }
    const A = { pos: gl.getAttribLocation(prog, 'aPos'), nrm: gl.getAttribLocation(prog, 'aNrm'), col: gl.getAttribLocation(prog, 'aCol') };
    const TA = { pos: gl.getAttribLocation(tprog, 'aPos'), uv: gl.getAttribLocation(tprog, 'aUV') };
    const U = {}, TU = {};
    ['uVP', 'uEye', 'uLit', 'uFog', 'uFogCol', 'uAlpha'].forEach((k) => (U[k] = gl.getUniformLocation(prog, k)));
    ['uVP', 'uEye', 'uFog', 'uFogCol', 'uTex', 'uTint'].forEach((k) => (TU[k] = gl.getUniformLocation(tprog, k)));
    const maxAttr = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    const onlyAttribs = (list) => {
      for (let i = 0; i < Math.min(8, maxAttr); i++) gl.disableVertexAttribArray(i);
      list.forEach((a) => a >= 0 && gl.enableVertexAttribArray(a));
    };
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    const textures = new Set();
    const MODES = { tris: gl.TRIANGLES, strip: gl.TRIANGLE_STRIP, lines: gl.LINES, linestrip: gl.LINE_STRIP };
    const meshes = new Set();

    const R = {
      gl,
      sharp, // the imagery shader with bicubic zoom and sharpening (false: plain fallback)
      mesh(mode, data) {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const m = { buf, mode: MODES[mode], count: data.length / STRIDE };
        meshes.add(m);
        return m;
      },
      texMesh(mode, data) {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const m = { buf, mode: MODES[mode], count: data.length / TSTRIDE, textured: true };
        meshes.add(m);
        return m;
      },
      texture(img) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        const pot = (v) => (v & (v - 1)) === 0;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (pot(img.width) && pot(img.height)) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
        } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        textures.add(t);
        return t;
      },
      freeTexture(t) {
        if (t && textures.has(t)) {
          gl.deleteTexture(t);
          textures.delete(t);
        }
      },
      /** A mesh rewritten every frame (the cars): m.set(data) replaces its vertices. */
      dynamic(mode) {
        const buf = gl.createBuffer();
        const m = { buf, mode: MODES[mode], count: 0 };
        let cap = 0;
        m.set = (data) => {
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          // the store is only reallocated when the data outgrows it
          if (data.length > cap) gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW), (cap = data.length);
          else gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
          m.count = data.length / STRIDE;
        };
        meshes.add(m);
        return m;
      },
      free(m) {
        if (m && meshes.has(m)) {
          gl.deleteBuffer(m.buf);
          meshes.delete(m);
        }
      },
      resize() {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
      },
      draw(vp, eye, items, fog) {
        const bg = fog.color;
        gl.clearColor(bg[0], bg[1], bg[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        const texd = items.filter((i) => i.tex && i.mesh && i.mesh.count);
        if (texd.length) {
          gl.useProgram(tprog);
          onlyAttribs([TA.pos, TA.uv]);
          gl.uniformMatrix4fv(TU.uVP, false, vp);
          gl.uniform3fv(TU.uEye, eye);
          gl.uniform2f(TU.uFog, fog.near, fog.far);
          gl.uniform3fv(TU.uFogCol, bg);
          gl.uniform1i(TU.uTex, 0);
          gl.activeTexture(gl.TEXTURE0);
          texd.forEach((it) => {
            gl.bindBuffer(gl.ARRAY_BUFFER, it.mesh.buf);
            gl.vertexAttribPointer(TA.pos, 3, gl.FLOAT, false, TSTRIDE * 4, 0);
            gl.vertexAttribPointer(TA.uv, 2, gl.FLOAT, false, TSTRIDE * 4, 12);
            gl.bindTexture(gl.TEXTURE_2D, it.tex);
            gl.uniform3fv(TU.uTint, it.tint || [1, 1, 1]);
            if (it.lift) {
              gl.enable(gl.POLYGON_OFFSET_FILL);
              gl.polygonOffset(-it.lift, -it.lift * 4);
            } else gl.disable(gl.POLYGON_OFFSET_FILL);
            gl.drawArrays(it.mesh.mode, 0, it.mesh.count);
          });
        }
        items = items.filter((i) => !i.tex);
        gl.useProgram(prog);
        onlyAttribs([]);
        gl.uniformMatrix4fv(U.uVP, false, vp);
        gl.uniform3fv(U.uEye, eye);
        gl.uniform2f(U.uFog, fog.near, fog.far);
        gl.uniform3fv(U.uFogCol, bg);
        gl.uniform1f(U.uAlpha, 1);
        gl.enableVertexAttribArray(A.pos);
        gl.enableVertexAttribArray(A.nrm);
        gl.enableVertexAttribArray(A.col);
        // passthru: the body as usual, except where it hides it.xray.mesh (drawn already), where
        // only its nearest surface is drawn, at it.xray.alpha. The stencil holds those pixels.
        const xray = (it) => {
          const raw = (m) => ({ mesh: m, lit: it.lit });
          gl.enable(gl.STENCIL_TEST);
          gl.clearStencil(0);
          gl.clear(gl.STENCIL_BUFFER_BIT);
          gl.stencilFunc(gl.ALWAYS, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.colorMask(false, false, false, false);
          gl.depthFunc(gl.LEQUAL);
          pass(Object.assign(raw(it.xray.mesh), { noDepth: true }));
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          gl.depthFunc(gl.LESS);
          gl.colorMask(true, true, true, true);
          gl.stencilFunc(gl.EQUAL, 0, 0xff);
          pass(raw(it.mesh));
          gl.stencilFunc(gl.EQUAL, 1, 0xff);
          gl.colorMask(false, false, false, false);
          pass(raw(it.mesh));
          gl.colorMask(true, true, true, true);
          gl.depthFunc(gl.EQUAL);
          gl.uniform1f(U.uAlpha, it.xray.alpha);
          pass(Object.assign(raw(it.mesh), { blend: true }));
          gl.uniform1f(U.uAlpha, 1);
          gl.depthFunc(gl.LESS);
          gl.disable(gl.STENCIL_TEST);
        };
        const pass = (it) => {
          if (!it.mesh || !it.mesh.count) return;
          gl.bindBuffer(gl.ARRAY_BUFFER, it.mesh.buf);
          gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, STRIDE * 4, 0);
          gl.vertexAttribPointer(A.nrm, 3, gl.FLOAT, false, STRIDE * 4, 12);
          gl.vertexAttribPointer(A.col, 4, gl.FLOAT, false, STRIDE * 4, 24);
          gl.uniform1f(U.uLit, it.lit ? 1 : 0);
          if (it.lift) {
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(-it.lift, -it.lift * 4);
          } else gl.disable(gl.POLYGON_OFFSET_FILL);
          if (it.blend) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
          } else {
            gl.disable(gl.BLEND);
            gl.depthMask(!it.noDepth);
          }
          gl.drawArrays(it.mesh.mode, 0, it.mesh.count);
        };
        items.filter((i) => !i.blend && !i.xray).forEach(pass);
        items.filter((i) => i.xray).forEach(xray);
        items.filter((i) => i.blend).forEach(pass);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      },
      destroy() {
        meshes.forEach((m) => gl.deleteBuffer(m.buf));
        meshes.clear();
        textures.forEach((t) => gl.deleteTexture(t));
        textures.clear();
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      },
    };
    return R;
  }

  /** Growable vertex list. */
  function Verts() {
    let a = new Float32Array(4096 * STRIDE), n = 0;
    return {
      push(x, y, z, nx, ny, nz, c, alpha) {
        if (n + STRIDE > a.length) {
          const b = new Float32Array(a.length * 2);
          b.set(a);
          a = b;
        }
        a[n++] = x; a[n++] = y; a[n++] = z;
        a[n++] = nx; a[n++] = ny; a[n++] = nz;
        a[n++] = c[0]; a[n++] = c[1]; a[n++] = c[2]; a[n++] = alpha == null ? 1 : alpha;
      },
      get length() {
        return n / STRIDE;
      },
      /** Empty it, keeping its memory: for a list refilled every frame. */
      reset() {
        n = 0;
      },
      data: () => a.subarray(0, n),
    };
  }

  /** '#rrggbb' -> [r, g, b] in 0..1 */
  const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

  IST.Review.GL = { create, Verts, rgb, STRIDE, TSTRIDE };
})();
