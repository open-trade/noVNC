const webpack = require('webpack');
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const BUILD_DIR = path.resolve(__dirname, 'build');
const SRC_DIR = path.resolve(__dirname, 'app');

console.log('BUILD_DIR', BUILD_DIR);
console.log('SRC_DIR', SRC_DIR);

module.exports = (env = {}) => {
  return {
    entry: {
      index: [SRC_DIR + '/ui.js']
    },
    output: {
      path: BUILD_DIR,
      filename: '[name]-[hash].bundle.js'
    },
    // watch: true,
    devtool: env.prod ? false : 'cheap-module-eval-source-map',
    devServer: {
      contentBase: BUILD_DIR,
      //   port: 9001,
      compress: true,
      hot: true,
      open: true
    },
    module: {
      rules: [
        {
          test: /\.(js|jsx)$/,
          // exclude: /node_modules/,
          include: [/node_modules\/react-data-grid-addons/, /src/],
          use: {
            loader: 'babel-loader',
            options: {
              cacheDirectory: true,
            }
          }
        },
        {
          test: /\.html$/,
          loader: 'html-loader'
        },
        {
          test: /\.(scss)$/,
          use: [
            'css-hot-loader',
            MiniCssExtractPlugin.loader,
            // 'style-loader',
            {
              loader: 'css-loader',
              options: {alias: {'../img': '../public/img'}}
            },
            'sass-loader',
          ],
        },
        {
          test: /\.css$/,
          use: [
            'css-hot-loader',
            MiniCssExtractPlugin.loader,
            // 'style-loader',
            'css-loader',
          ]
        },
        {
          test: /\.(png|jpg|jpeg|gif|ico|svg)$/,
          use: [
            {
              // loader: 'url-loader'
              loader: 'file-loader',
              options: {
                name: './img/[name].[hash].[ext]'
              }
            }
          ]
        },
        {
          test: /\.(woff(2)?|ttf|eot)(\?v=\d+\.\d+\.\d+)?$/,
          loader: 'file-loader',
          options: {
            name: './fonts/[name].[hash].[ext]'
          }
        }]
    },
    plugins: [
      new webpack.HotModuleReplacementPlugin(),
      new webpack.NamedModulesPlugin(),
      new MiniCssExtractPlugin({
          filename: '[name]-[chunkhash].css',
          chunkFilename: '[id].css'
      }),
      new HtmlWebpackPlugin(
        {
          inject: true,
          template: './vnc.html'
        }
      ),
      new CopyWebpackPlugin([
          {from: './app/images/', to: 'app/images'},
          {from: './app/sounds/', to: 'app/sounds'},
          {from: './app/locale/', to: 'app/locale'},
        ],
        {copyUnmodified: false}
      )
    ]
  }
};
