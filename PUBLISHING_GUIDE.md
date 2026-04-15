# 发布新版本指南

## 更新版本发布流程

当您修改代码后需要发布新版本时，请按照以下步骤操作：

### 1. 确认代码已提交
确保所有代码更改都已提交到git：
```bash
git status
git add .
git commit -m "描述您的更改"
```

### 2. 更新包版本

根据更改类型选择合适的版本更新命令：

#### 补丁版本（修复bug）
```bash
# 在 packages/core 目录
cd packages/core
npm version patch

# 在 packages/studio 目录  
cd ../studio
npm version patch

# 在 packages/cli 目录
cd ../cli
npm version patch
```

#### 小版本（新功能）
```bash
# 使用 minor 替代 patch
npm version minor
```

#### 大版本（破坏性更改）
```bash
# 使用 major 替代 patch
npm version major
```

### 3. 更新依赖关系（如果需要）

如果core或studio包版本更新，需要更新CLI包的依赖：
```bash
# 在 packages/cli 目录
cd packages/cli
# 手动更新 package.json 中的依赖版本
# 或者运行准备脚本
node ../../scripts/prepare-package-for-publish.mjs
```

### 4. 推送版本标签到远程仓库
```bash
# 回到项目根目录
cd ../../
git push origin master --tags
```

### 5. 发布包到npm

按照依赖顺序发布：core → studio → cli

```bash
# 发布 core 包
cd packages/core
pnpm publish --access public

# 发布 studio 包
cd ../studio  
pnpm publish --access public

# 发布 cli 包
cd ../cli
pnpm publish --access public
```

## 常见问题解决

### 错误：ERR_PNPM_GIT_UNCLEAN
**原因**：工作目录有未提交的更改
**解决**：提交或暂存更改，或使用 `--no-git-checks` 参数

### 错误：403 Forbidden - 版本已存在
**原因**：尝试发布已存在的版本号
**解决**：使用 `npm version` 命令更新版本号

### 错误：workspace:* 协议验证失败
**原因**：依赖版本不匹配
**解决**：运行 `node ../../scripts/prepare-package-for-publish.mjs` 更新依赖版本

### 错误：401 Unauthorized
**原因**：未登录npm
**解决**：运行 `npm login` 重新登录

## 快速发布脚本

如果您需要频繁发布，可以创建一个脚本来自动化流程：

```bash
#!/bin/bash
# quick-publish.sh

echo "更新所有包版本..."
cd packages/core && npm version patch
cd ../studio && npm version patch  
cd ../cli && npm version patch

echo "推送版本标签..."
cd ../../ && git push origin master --tags

echo "发布包..."
cd packages/core && pnpm publish --access public
cd ../studio && pnpm publish --access public
cd ../cli && pnpm publish --access public

echo "发布完成！"
```

## 验证发布

发布后可以通过以下命令验证：

```bash
npm view inkos-n-core
npm view inkos-n-studio
npm view inkos-n
```

或者在npm官网查看：
- https://www.npmjs.com/package/inkos-n-core
- https://www.npmjs.com/package/inkos-n-studio  
- https://www.npmjs.com/package/inkos-n

## 版本号规则

- **主版本号**：不兼容的API修改
- **次版本号**：向下兼容的功能性新增
- **修订号**：向下兼容的问题修正

示例：1.2.3 → 1.2.4（补丁）→ 1.3.0（小版本）→ 2.0.0（大版本）
