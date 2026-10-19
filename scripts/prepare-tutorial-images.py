"""Prepare reviewed tutorial PNGs with solid example labels and lossless WebP.

Usage: python scripts/prepare-tutorial-images.py /path/to/deploy-pic
Originals stay untouched. Expected dimensions prevent applying these reviewed
rectangles to a different capture. A fresh RGB encoding drops source metadata.
"""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
# Mask coordinates and font sizes use the review viewport; scale to source pixels.
REVIEWED = {
    'access': ((2522, 1311), (2048, 1065), [
        ((724, y, 1280, y + 40), 'example.com', 25)
        for y in (214, 328, 448, 568, 688, 808, 928)
    ]),
    'add-secret': ((1217, 680), (1217, 680), []),
    'bindings': ((1788, 636), (1788, 636), [
        ((823, 222, 1510, 279), 'Namespace ID: YOUR_ADMIN_NAMESPACE_ID', 28),
        ((823, 322, 1510, 379), 'Namespace ID: YOUR_API_NAMESPACE_ID', 28),
    ]),
    'builds': ((1840, 2457), (1366, 1824), [
        ((590, 1310, 1203, 1352), 'YOUR_RESOURCE_CONFIG_JSON', 24),
    ]),
    'r2-cors': ((1515, 1424), (1515, 1424), [
        ((306, 410, 809, 451), 'https://parcel.example.com', 26),
    ]),
    'r2-token': ((2327, 2345), (2327, 2345), []),
    'template-build': ((2453, 1341), (2453, 1341), []),
    'variables': ((1750, 1859), (1536, 1631), [
        ((706, 194, 1340, 243), 'YOUR_ACCESS_AUD', 24),
        ((706, 289, 1340, 338), 'https://YOUR_TEAM.cloudflareaccess.com', 24),
        ((706, 481, 1340, 530), 'admin@example.com', 24),
        ((706, 865, 1340, 914), 'https://parcel.example.com', 24),
        ((706, 1152, 1340, 1201), 'https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com', 24),
    ]),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    default_font = 'C:/Windows/Fonts/segoeui.ttf'
    parser.add_argument('--font', default=default_font if Path(default_font).is_file() else 'DejaVuSans.ttf')
    args = parser.parse_args()
    target = ROOT / 'docs/site/images'
    target.mkdir(parents=True, exist_ok=True)
    for name, (expected, review, labels) in REVIEWED.items():
        with Image.open(args.source / f'{name}.png') as source:
            if source.size != expected:
                raise ValueError(f'{name}: review changed dimensions {source.size} before redacting')
            output = Image.new('RGB', source.size, 'white')
            output.paste(source.convert('RGB'))
        draw = ImageDraw.Draw(output)
        sx, sy = output.width / review[0], output.height / review[1]
        for rect, label, size in labels:
            x1, y1, x2, y2 = [int(v * (sx if i % 2 == 0 else sy)) for i, v in enumerate(rect)]
            draw.rectangle((x1, y1, x2, y2), fill='#202020')
            font_size = round(size * sy)
            padding = round(8 * sx)
            font = ImageFont.truetype(args.font, font_size)
            while draw.textlength(label, font=font) > x2 - x1 - 2 * padding:
                font_size -= 1
                if font_size < 10:
                    raise ValueError(f'{name}: label does not fit its reviewed mask')
                font = ImageFont.truetype(args.font, font_size)
            draw.text((x1 + padding, (y1 + y2) / 2), label, font=font, fill='white', anchor='lm')
        output.save(target / f'{name}.webp', 'WEBP', lossless=True, method=6)
        print(f'{name}.webp: {output.width}x{output.height}, {len(labels)} example labels')


if __name__ == '__main__':
    main()
