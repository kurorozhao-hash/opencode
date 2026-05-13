# OpenCode 桌面版构建指南

本文档提供完整的 OpenCode 桌面应用构建说明，支持 macOS、Windows 和 Linux 平台。

## 目录

- [构建方法](#构建方法)
- [构建前准备](#构建前准备)
- [构建产物](#构建产物)
- [构建脚本](#构建脚本)
- [常见问题](#常见问题)

## 构建方法

### 方法 1：本地开发编译（推荐测试）

```bash
cd opencode

# 1. 安装依赖
bun install

# 2. 开发模式运行桌面版
bun run dev:desktop

# 3. 构建桌面版（当前平台）
cd packages/desktop
bun run tauri build
```

### 方法 2：生产环境编译

**macOS:**
```bash
# 构建 Intel 芯片版本
bun run tauri build --target x86_64-apple-darwin

# 构建 Apple Silicon 版本
bun run tauri build --target aarch64-apple-darwin

# 构建通用二进制（同时支持 Intel 和 Apple Silicon）
bun run tauri build --target universal-apple-darwin
```

**Windows:**
```bash
# 构建 x64 版本
bun run tauri build --target x86_64-pc-windows-msvc

# 构建 ARM64 版本
bun run tauri build --target aarch64-pc-windows-msvc
```

**Linux:**
```bash
# 构建 x64 版本
bun run tauri build --target x86_64-unknown-linux-gnu

# 构建 ARM64 版本
bun run tauri build --target aarch64-unknown-linux-gnu
```

### 方法 3：使用 GitHub Actions 自动构建

项目已配置完整的 CI/CD 流程（`.github/workflows/publish.yml`）：

1. 推送代码到 `dev` 或 `beta` 分支
2. 或手动触发 workflow：
   - 进入 Actions 页面
   - 选择 "publish" workflow
   - 点击 "Run workflow"
   - 选择版本类型（major/minor/patch）

构建产物会自动上传到 GitHub Releases。

### 方法 4：使用构建脚本（推荐）

使用提供的构建脚本简化编译过程：

```bash
# 构建当前平台
./scripts/build-desktop.sh

# 构建 macOS 版本
./scripts/build-desktop.sh --platform macos

# 构建 Windows 版本
./scripts/build-desktop.sh --platform windows

# 构建 Linux 版本
./scripts/build-desktop.sh --platform linux

# 构建所有平台（需要交叉编译环境）
./scripts/build-desktop.sh --platform all
```

## 构建前准备

### macOS 要求

1. **Xcode Command Line Tools**
   ```bash
   xcode-select --install
   ```

2. **Apple Developer 证书**（用于签名和公证）
   - 需要有效的 Apple Developer 账号
   - 配置证书到钥匙串
   - 配置环境变量：
     ```bash
     export APPLE_CERTIFICATE="base64-encoded-certificate"
     export APPLE_CERTIFICATE_PASSWORD="certificate-password"
     export APPLE_API_ISSUER="issuer-id"
     export APPLE_API_KEY="api-key-id"
     ```

### Windows 要求

1. **Visual Studio Build Tools**
   - 下载并安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)
   - 选择 "Desktop development with C++" 工作负载

2. **Azure 代码签名证书**（可选）
   - 配置 Azure 签名服务
   - 配置环境变量：
     ```bash
     export AZURE_CLIENT_ID="client-id"
     export AZURE_TENANT_ID="tenant-id"
     export AZURE_SUBSCRIPTION_ID="subscription-id"
     export AZURE_TRUSTED_SIGNING_ACCOUNT_NAME="account-name"
     export AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE="certificate-profile"
     export AZURE_TRUSTED_SIGNING_ENDPOINT="endpoint-url"
     ```

### Linux 要求

安装必要的系统依赖：

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  pkg-config

# Fedora
sudo dnf install \
  webkit2gtk4.1-devel \
  libappindicator-gtk3-devel \
  librsvg2-devel \
  patchelf \
  gcc \
  gcc-c++ \
  make

# Arch Linux
sudo pacman -S \
  webkit2gtk-4.1 \
  libappindicator-gtk3 \
  librsvg \
  patchelf \
  base-devel
```

### Rust 环境

所有平台都需要安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# 安装所需的目标平台
rustup target add x86_64-apple-darwin      # macOS Intel
rustup target add aarch64-apple-darwin     # macOS Apple Silicon
rustup target add x86_64-pc-windows-msvc   # Windows x64
rustup target add aarch64-pc-windows-msvc  # Windows ARM64
rustup target add x86_64-unknown-linux-gnu # Linux x64
rustup target add aarch64-unknown-linux-gnu # Linux ARM64
```

## 构建产物

编译完成后，产物位于：

```
packages/desktop/src-tauri/target/release/bundle/
├── dmg/              # macOS DMG 安装包
│   └── OpenCode_x.x.x_x64.dmg
│   └── OpenCode_x.x.x_aarch64.dmg
│   └── OpenCode_x.x.x_universal.dmg
├── macos/            # macOS .app 应用
│   └── OpenCode.app
├── nsis/             # Windows NSIS 安装包
│   └── OpenCode_x.x.x_x64-setup.exe
│   └── OpenCode_x.x.x_x64_en-US.exe
├── msi/              # Windows MSI 安装包
│   └── OpenCode_x.x.x_x64_en-US.msi
├── deb/              # Debian/Ubuntu 包
│   └── opencode-desktop_x.x.x_amd64.deb
│   └── opencode-desktop_x.x.x_arm64.deb
├── rpm/              # RedHat/Fedora 包
│   └── opencode-desktop-x.x.x.x86_64.rpm
│   └── opencode-desktop-x.x.x.aarch64.rpm
└── appimage/         # Linux AppImage
    └── opencode-desktop_x.x.x_amd64.AppImage
    └── opencode-desktop_x.x.x_arm64.AppImage
```

## 构建脚本

### build-desktop.sh

位于 `packages/desktop/scripts/build-desktop.sh`，提供便捷的构建命令：

```bash
#!/usr/bin/env bash
# 使用方法
./scripts/build-desktop.sh [选项]

选项:
  --platform <platform>   目标平台 (macos/windows/linux/all/current)
  --arch <arch>          目标架构 (x64/arm64/universal)
  --release              构建发布版本（默认）
  --debug                构建调试版本
  --help                 显示帮助信息

示例:
  ./scripts/build-desktop.sh                           # 构建当前平台
  ./scripts/build-desktop.sh --platform macos          # 构建 macOS
  ./scripts/build-desktop.sh --platform windows --arch x64  # 构建 Windows x64
  ./scripts/build-desktop.sh --platform all            # 构建所有平台
```

### build-desktop.ts

使用 TypeScript 编写的跨平台构建脚本：

```bash
# 构建当前平台
bun run scripts/build-desktop.ts

# 构建指定平台
bun run scripts/build-desktop.ts --platform macos --arch universal
bun run scripts/build-desktop.ts --platform windows --arch x64
bun run scripts/build-desktop.ts --platform linux --arch arm64
```

## 常见问题

### 1. macOS 签名失败

**问题**: `No signing certificate found`

**解决**:
```bash
# 检查证书
security find-identity -v -p codesigning

# 导入证书
security import certificate.p12 -k ~/Library/Keychains/login.keychain-db
```

### 2. Windows 构建失败

**问题**: `linker 'link.exe' not found`

**解决**:
- 安装 Visual Studio Build Tools
- 确保 MSVC 工具链正确安装
- 重启终端使环境变量生效

### 3. Linux WebKit 缺失

**问题**: `Package webkit2gtk-4.1 was not found`

**解决**:
```bash
# Ubuntu/Debian
sudo apt-get install libwebkit2gtk-4.1-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel
```

### 4. Rust 版本不兼容

**问题**: `rustc version is too old`

**解决**:
```bash
# 更新 Rust
rustup update stable

# 验证版本
rustc --version  # 需要 >= 1.70
```

### 5. 构建产物过大

**问题**: DMG 或 EXE 文件过大

**解决**:
- 使用 release 模式构建（默认）
- 启用优化选项
- 排除不必要的依赖

### 6. 交叉编译问题

**问题**: 无法在 macOS 上构建 Windows 版本

**解决**:
- 使用 GitHub Actions 进行跨平台构建
- 或在各自平台上构建
- 或使用 Docker 容器进行 Linux 构建

## 版本信息

当前版本配置：

- **产品名**: OpenCode Dev
- **版本**: 1.4.6
- **Bundle ID**: ai.opencode.desktop.dev
- **支持格式**: dmg, app, nsis, deb, rpm, appimage

查看完整配置：`packages/desktop/src-tauri/tauri.conf.json`

## 相关链接

- [Tauri 官方文档](https://tauri.app/v2/guides/)
- [Tauri 构建指南](https://tauri.app/v2/guides/building/)
- [OpenCode GitHub](https://github.com/anomalyco/opencode)
- [OpenCode 文档](https://opencode.ai/docs)

## 更新日志

- 2025-05-13: 创建构建文档
- 版本 1.4.6: 当前稳定版本

---

如有问题或建议，请提交 Issue 或 Pull Request。