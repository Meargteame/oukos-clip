# desktop/assets/

Place your app icon here as `icon.ico`.

The icon should be a multi-resolution `.ico` file (recommended sizes: 16x16, 32x32, 48x48, 64x64, 128x128, 256x256).

You can convert a PNG to ICO using an online tool or ImageMagick:

```
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

The build config in `package.json` references `assets/icon.ico` for both the
window icon and the Windows installer.
