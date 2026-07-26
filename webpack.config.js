module.exports = function (options, webpack) {
  return {
    ...options,
    externals: [
      ...(options.externals || []),
      'canvas',
    ],
    watchOptions: {
      poll: 1000,
      aggregateTimeout: 300,
      ignored: /node_modules/,
    },
  };
};