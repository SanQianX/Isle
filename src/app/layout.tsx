import type { Metadata, Viewport } from 'next';
import './globals.css';
import './isle.css';

export const metadata: Metadata = {
  title: 'ISLE 屿集 — 每一处风景，都值得被看见',
  description:
    '以地点为中心的旅行照片榜。上传你拍过的风景，给喜欢的照片投票，一起选出这里最好看的那张。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f8f9f6',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-tone="paper" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
