
我需要你开发一套基于对象存储为后端的网盘软件，用于文件共享、传输
## 业务逻辑

- 轻量，不做树结构，只有project/blob二级目录
- 支持对公分享，生成分享链接，支持加密分享
## 技术选型

- 对接backblaze b2、cloudflare R2、aws S3、rustfs等S3对象存储
- 支持直接从S3上传下载（通过presigned s3）
- 原生使用cloudflare workers，可选在docker中运行
- 支持OIDC登陆，优先适配Authentik
## 客户端

需要同步开发Web前端和CLI，建议用go开发cli
- CLI 也能通过 OIDC 浏览器授权登录（类似gh工具那样）
- CLI能够管理project，上传下载
- 客户端支持多平台（Linux/Mac，amd64/arm64），最好是单一二进制
- 支持网页端交互

## 使用体验

- 管理员部署时，需要提供一个one-off的secret，根据这个secret自助注册
- 管理员可以配置存储后端，对接OIDC
- 管理员可以看dashboard得知这个系统的使用情况（用量、请求数、请求的数据量）
- 管理元可以对用户进行管理，并且进行容量限制的调节
- OIDC新用户登陆后自动注册，支持HS256/RS256，
## 参考实现

- ZPan https://github.com/saltbo/zpan 参考它的UI库
- Safebucket https://github.com/safebucket/safebucket
- Plik https://github.com/root-gg/plik
## 其他注意事项

- 基于Makefile管理主要的Target
- 设计合适的AGENTS.md来辅佐其他Agent工作
- 注重多语言支持（中/英）
- 不提倡过度防御编程
- 考虑到cloudflare的并发限制
- 管理员需要支持两步验证
- 内部使用，不需要过度设计（例如计费）
- 注意垃圾回收，错误处理
