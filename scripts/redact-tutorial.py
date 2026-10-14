"""Crop observed dashboard screenshots and permanently cover private fields.

Original screenshots and coordinates stay in ignored .parcel-tutorial/.
Only flattened WebP files are published. Run with Pillow installed.
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
source = root / '.parcel-tutorial'
target = root / 'docs/site/images'
target.mkdir(parents=True, exist_ok=True)

def flatten(name, crop, masks=()):
    im = Image.open(source / (name + '.jpg')).convert('RGB')
    draw = ImageDraw.Draw(im)
    for r in masks:
        x, y, w, h = (r[k] for k in ('x', 'y', 'width', 'height'))
        draw.rectangle((int(x), int(y), int(x+w+1), int(y+h+1)), fill='#202020')
    x, y, w, h = (crop[k] for k in ('x', 'y', 'width', 'height'))
    im = im.crop((int(x), int(y), int(x+w), int(y+h)))
    im.save(target / (name + '.webp'), 'WEBP', quality=90, method=6)

if __name__ == '__main__':
    data = json.loads((source / 'worker-settings.json').read_text())
    for section in data['sections']:
        name = section['id']
        im = Image.open(source / 'worker-settings.jpg').convert('RGB')
        draw = ImageDraw.Draw(im)
        for r in data['masks'] + data['buildMasks']:
            # Full-page capture can reflow table columns at scrollbar width.
            # Cover the entire value area, including a conservative left margin.
            draw.rectangle((500, int(r['y'])-2, 915, int(r['y']+r['height']+2)), fill='#202020')
        r = section['rect']
        im.crop((int(r['x']), int(r['y']), int(r['x']+r['width']), int(r['y']+r['height']))).save(target / (name+'.webp'), 'WEBP', quality=90, method=6)
    flatten('add-secret', {'x':212, 'y':64, 'width':600, 'height':338})
    for metadata in source.glob('capture-*.json'):
        item = json.loads(metadata.read_text())
        flatten(item['name'], item['crop'], item.get('masks', []))
    print('Saved flattened WebP screenshots; originals remain ignored.')
