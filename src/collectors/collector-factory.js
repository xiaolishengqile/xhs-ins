export function createCollectorFactory({ browserManager, collectors }) {
  return (platform) => {
    const Collector = collectors[platform];
    if (!Collector) throw new Error(`不支持的平台：${platform}`);
    return new Collector({ browserManager });
  };
}
