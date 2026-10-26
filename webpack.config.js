import path from 'path'
import TerserPlugin from 'terser-webpack-plugin'

// Configuration for multiple builds
const builds = [
  {
    name: 'wme',
    entry: './codec/boundary/wme.js',
    output: {
      filename: 'index.js',
      library: { type: 'module' },
    },
    experiments: { outputModule: true },
  },
  {
    name: 'library',
    entry: './codec/index.js',
    output: {
      filename: 'carta5.min.js',
      library: 'Carta5',
      libraryTarget: 'umd',
      globalObject: 'this',
    },
  },
  {
    name: 'worker',
    entry: './codec/boundary/worker.js',
    output: {
      filename: 'carta5-worker.min.js',
      libraryTarget: 'self',
    },
  },
  {
    name: 'interface',
    entry: './codec/boundary/browser.js',
    output: {
      filename: 'carta5-worker-interface.min.js',
      libraryTarget: 'module',
      globalObject: 'this',
    },
    experiments: { outputModule: true },
  },
]

export default (env = {}) =>
  builds
    .filter(({ name }) =>
      env.wme ? name === 'wme' || name === 'worker' : name !== 'wme'
    )
    .map(({ name, entry, output, experiments }) => ({
      name,
      mode: 'production',
      entry,
      output: { ...output, path: path.resolve(env.wme || 'dist') },
      module: {
        rules: [
          {
            test: /\.js$/,
            exclude: /node_modules/,
            use: {
              loader: 'babel-loader',
              options: {
                presets: ['@babel/preset-env'],
              },
            },
          },
        ],
      },
      optimization: {
        minimize: true,
        minimizer: [
          new TerserPlugin({
            extractComments: false,
          }),
        ],
      },
      devtool: 'source-map',
      experiments,
    }))
