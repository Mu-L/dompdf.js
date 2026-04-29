import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import sourceMaps from 'rollup-plugin-sourcemaps';
import {terser} from 'rollup-plugin-terser';

const pkg = require('./package.json');

const banner = `/*!
 * ${pkg.title} ${pkg.version} <${pkg.homepage}>
 * Copyright (c) ${(new Date()).getFullYear()} ${pkg.author.name} <${pkg.author.url}>
 * Released under ${pkg.license} License
 */`;

const sharedPlugins = (tsOptions = {}) => [
    resolve({
        exportConditions: ['browser', 'module', 'import', 'default']
    }),
    json(),
    typescript({ sourceMap: true, inlineSources: true, ...tsOptions }),
    commonjs({
        include: 'node_modules/**',
    }),
    sourceMaps(),
];

// UMD builds: single-file, inline dynamic imports (UMD does not support code-splitting)
const umdConfig = {
    input: `src/index.ts`,
    output: [
        {
            file: pkg.main,
            name: 'dompdf',
            format: 'umd',
            banner,
            sourcemap: true,
            inlineDynamicImports: true,
        },
        {
            file: 'dist/dompdf.min.js',
            name: 'dompdf',
            format: 'umd',
            banner,
            sourcemap: true,
            inlineDynamicImports: true,
            plugins: [terser({
                compress: {drop_console: false, passes: 2},
                format: {comments: /^!/},
            })],
        },
    ],
    external: [],
    plugins: sharedPlugins(),
};

// ESM build: supports code-splitting, snapdom loaded as a separate chunk
const esmConfig = {
    input: `src/index.ts`,
    output: {
        dir: 'dist/esm',
        format: 'esm',
        entryFileNames: 'dompdf.esm.js',
        banner,
        sourcemap: true,
    },
    external: [],
    watch: {
        include: 'src/**',
    },
    plugins: sharedPlugins({outDir: 'dist/esm', declaration: false, declarationDir: undefined}),
};

export default [umdConfig, esmConfig];
