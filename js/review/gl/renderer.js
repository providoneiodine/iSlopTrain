/*
 * A minimal WebGL renderer for the Review viewer: one shader, interleaved
 * vertex buffers, a draw list. No scene graph and no dependencies.
 *
 *   const R = IST.Review.GL.create(canvas)     null if WebGL isn't available
 *   R.mesh(mode, data)        upload; mode 'tris' | 'strip' | 'lines' | 'linestrip';
 *                             data: Float32Array of [x y z  nx ny nz  r g b a] per vertex
 *   R.free(mesh)
 *   R.draw(viewProj, eye, items, fog)  items: [{ mesh, lit, blend, depth, lift }]
 *   R.resize()                match the canvas to its CSS size x devicePixelRatio
 *   R.destroy()
 *
 * lit: 0 flat colour, 1 lit by a fixed sun (so slopes read as shape).
 * blend: alpha-blend and don't write depth (fences). lift: polygon offset so
 * lines drawn on the road win the depth test.
 * GL.Verts() is a growable vertex list, so Scene writes plain geometry.
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
    'uniform vec3 uFogCol; varying vec4 vCol; varying float vFog;',
    'void main() { gl_FragColor = vec4(mix(vCol.rgb, uFogCol, vFog), vCol.a); }',
  ].join('\n');

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function create(canvas) {
    const gl = canvas.getContext && (canvas.getContext('webgl', { antialias: true, alpha: false }) || canvas.getContext('experimental-webgl'));
    if (!gl) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const A = { pos: gl.getAttribLocation(prog, 'aPos'), nrm: gl.getAttribLocation(prog, 'aNrm'), col: gl.getAttribLocation(prog, 'aCol') };
    const U = {};
    ['uVP', 'uEye', 'uLit', 'uFog', 'uFogCol'].forEach((k) => (U[k] = gl.getUniformLocation(prog, k)));
    const MODES = { tris: gl.TRIANGLES, strip: gl.TRIANGLE_STRIP, lines: gl.LINES, linestrip: gl.LINE_STRIP };
    const meshes = new Set();

    const R = {
      gl,
      mesh(mode, data) {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const m = { buf, mode: MODES[mode], count: data.length / STRIDE };
        meshes.add(m);
        return m;
      },
      /** A mesh rewritten every frame (the cars): m.set(data) replaces its vertices. */
      dynamic(mode) {
        const buf = gl.createBuffer();
        const m = { buf, mode: MODES[mode], count: 0 };
        m.set = (data) => {
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
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
        gl.useProgram(prog);
        gl.uniformMatrix4fv(U.uVP, false, vp);
        gl.uniform3fv(U.uEye, eye);
        gl.uniform2f(U.uFog, fog.near, fog.far);
        gl.uniform3fv(U.uFogCol, bg);
        gl.enableVertexAttribArray(A.pos);
        gl.enableVertexAttribArray(A.nrm);
        gl.enableVertexAttribArray(A.col);
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
            gl.depthMask(true);
          }
          gl.drawArrays(it.mesh.mode, 0, it.mesh.count);
        };
        items.filter((i) => !i.blend).forEach(pass);
        items.filter((i) => i.blend).forEach(pass);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      },
      destroy() {
        meshes.forEach((m) => gl.deleteBuffer(m.buf));
        meshes.clear();
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
      data: () => a.subarray(0, n),
    };
  }

  /** '#rrggbb' -> [r, g, b] in 0..1 */
  const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

  IST.Review.GL = { create, Verts, rgb, STRIDE };
})();
