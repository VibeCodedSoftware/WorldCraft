import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { craftApi } from '../Shared/devserver/projectApi';

const here = __dirname;
const app = path.resolve(here, '..');

export default defineConfig({
  plugins: [
    react(),
    craftApi({
      app: 'worldcraft',
      projectsDir: path.join(here, 'projects'),
      exchangeDir: path.join(app, 'Shared', 'exchange'),
      // The environment assets shared with GameCraft and ParticleCraft (no other library: the Mail Delivery houses stay out).
      libraryDirs: [{ id: 'world', dir: path.join(app, 'GameCraft/asset-library/world'), label: 'World assets' }],
    }),
  ],
  resolve: {
    alias: {
      '@shared': path.join(app, 'Shared'),
      // GameCraft's three.js, model loaders and water material.
      three: path.join(app, 'GameCraft/node_modules/three'),
      '@gamecraft': path.join(app, 'GameCraft/src'),
      react: path.join(here, 'node_modules/react'),
      'react-dom': path.join(here, 'node_modules/react-dom'),
    },
  },
  server: { fs: { allow: [app] }, port: 5176, watch: { ignored: ['**/projects/**'] } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
