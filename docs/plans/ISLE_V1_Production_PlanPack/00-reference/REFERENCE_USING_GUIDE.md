# 原型和截图使用限制

- `PRODUCT_REQUIREMENTS.md` 是本次实现的产品真实需求。
- `V4.1_REFERENCE_ONLY.html` 是可交互视觉原型，它使用 JS 常量、浏览器 `localStorage`、对象 URL 和远程素材；没有真正的数据库、服务器上传和投票事务。
- `gallery-justified-reference.png` 是用户提出横竖混排问题之后的修复效果：同一行照片等高、宽度按比例变化。正式实现需基于数据库字段 `width/height` 进行布局，不能用剪切截图作为上传照片。
- `desktop-home-reference.png` / `mobile-home-reference.png` 用于设计还原和人工 review，不保证所有远程图片在离线环境可加载。
- 参考 HTML 只用于比对色彩、排版、页面分区、动态规划布局、交互细节；**禁止直接部署单文件 HTML 并声称拥有正式后端**。
- 禁止将含水印、没有许可证明或仅用于测试的截图合成素材默认公开发布为“桂山岛真实照片”。
