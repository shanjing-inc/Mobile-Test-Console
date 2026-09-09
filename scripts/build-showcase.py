#!/usr/bin/env python3
"""从已审阅的 1920×972 实录生成宣传素材；需要 Python 3、Pillow、ffmpeg/ffprobe。"""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SIZE = (1280, 800)
BG = '#101f2b'
SOURCE_SHA256 = '569d8e0a5878d99630d2c884b28f6aec295d6ef9d76427df2301042ce330e45f'
TEAL = '#61ddcb'
WHITE = '#f3f8fc'
FONT_CANDIDATES = (
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
)

# 坐标采用源片像素。每个定格独立审阅，避免滚动中的隐私字段进入镜头。
# 格式：名称、源秒、输出秒、动态源长度（0 表示定格）、裁切、遮挡框、标题、字幕。
SHOTS = [
    ('devices', 10, 4, 0, (230, 64, 1878, 733),
     [(284, 215, 447, 238), (284, 283, 420, 304), (439, 167, 490, 185), (399, 236, 491, 254)],
     '01  /  APP · 选择设备', 'Android、iOS、HarmonyOS：选择运行目标与测试页面'),
    ('launch', 10, 4, 2, (535, 64, 1878, 733), [],
     '01  /  APP · 启动测试', '按页面范围启动，每个运行目标独立记录结果'),
    ('running', 24, 4, 0, (550, 431, 1872, 807),
     [(684, 497, 855, 515), (684, 603, 855, 622), (684, 654, 855, 675), (684, 761, 855, 781)],
     '01  /  APP · 运行状态', '查看各设备的执行状态；下方同时保留历史记录'),
    ('cancelled', 55, 4, 0, (550, 339, 1872, 711),
     [(684, 400, 855, 421), (684, 507, 855, 528), (684, 559, 855, 581), (684, 666, 855, 688)],
     '02  /  APP · 转入历史结果', '本次演示启动后取消，以下展示历史测试结果'),
    ('overview', 57, 8, 0, (550, 215, 1872, 802),
     [(618, 625, 824, 642)],
     '02  /  APP · 历史结果总览', '历史记录：77 条用例、156 张截图，结果与页面证据集中查看'),
    ('screenshots', 71.5, 8, 0, (550, 65, 1872, 680),
     [(618, 153, 824, 174), (618, 502, 824, 523)],
     '02  /  APP · 历史页面截图', '逐页查看商品推荐与分享页面，保留用例状态及截图关联'),
    ('api', 90, 9, 0, (550, 404, 1872, 914),
     [(920, 586, 1140, 610), (620, 564, 865, 582)],
     '03  /  APP · 历史接口详情', '请求参数与响应结果并列呈现，关联具体页面和调用'),
    ('wechat-target', 103, 4, 0, (230, 156, 1878, 788), [],
     '04  /  微信小程序 · 运行目标', '微信开发者工具运行目标；接下来展示已有历史结果'),
    ('wechat-browse', 108, 4, 0, (550, 65, 1872, 970), [],
     '04  /  微信小程序 · 历史结果', '浏览页面检查记录和截图，保留各用例的实际状态'),
    ('wechat-errors', 113, 5, 5, (550, 65, 1872, 970), [],
     '04  /  微信小程序 · 异常页面', '历史结果包含未知、跳过与通过，截图保留 401 异常上下文'),
    ('wechat-hold', 114, 6, 0, (550, 65, 1872, 970), [],
     '04  /  微信小程序 · 结果与证据', '对照用例状态与异常截图，定位需要继续排查的页面'),
]


def run(args):
    subprocess.run([str(arg) for arg in args], check=True)


def ffmpeg(*args):
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args])


def text(draw, xy, value, size=24, color=WHITE):
    draw.text(xy, value, font=ImageFont.truetype(str(FONT), size), fill=color)


def frame_at(source, seconds, path):
    ffmpeg('-ss', seconds, '-i', source, '-frames:v', 1, path)
    return Image.open(path).convert('RGB')


def safe_image(image, shot):
    image = image.copy()
    draw = ImageDraw.Draw(image)
    for box in shot[5]:
        draw.rectangle(box, fill='#dce7e9')
    return image.crop(shot[4])


def shell(title, subtitle, index):
    image = Image.new('RGB', SIZE, BG)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((32, 24, 91, 72), 12, fill=TEAL)
    text(draw, (42, 33), 'MTC', 20, BG)
    text(draw, (110, 29), title, 26)
    text(draw, (33, 714), subtitle, 23)
    text(draw, (33, 755), '真实操作实录  /  历史结果已标注  /  个人信息已遮挡', 15, '#98b0bf')
    text(draw, (1120, 755), f'{index:02d} / 11', 15, '#98b0bf')
    draw.rectangle((32, 790, 32 + int(1216 * index / 11), 794), fill=TEAL)
    return image


def place(image, content):
    content = ImageOps.contain(content, (1216, 600), Image.Resampling.LANCZOS)
    image.paste(content, (32 + (1216 - content.width) // 2, 100 + (600 - content.height) // 2))
    return image


def encode_still(image_path, seconds, output):
    ffmpeg('-loop', 1, '-framerate', 30, '-i', image_path, '-t', seconds,
           '-c:v', 'libx264', '-preset', 'medium', '-crf', 19, '-pix_fmt', 'yuv420p', '-an', output)


def render_shot(source, shot, index, temp):
    name, start, duration, source_duration, crop, masks, title, caption = shot
    canvas = shell(title, caption, index)
    background = temp / f'{name}-background.png'
    canvas.save(background)
    original = frame_at(source, start, temp / f'{name}-source.png')
    still = place(canvas.copy(), safe_image(original, shot))
    still_path = temp / f'{name}-safe.png'
    still.save(still_path)
    output = temp / f'{name}.mp4'
    if not source_duration:
        encode_still(still_path, duration, output)
        return output, still
    x1, y1, x2, y2 = crop
    filters = [f'drawbox=x={a}:y={b}:w={c-a}:h={d-b}:color=0xdce7e9:t=fill' for a, b, c, d in masks]
    filters += [f'crop={x2-x1}:{y2-y1}:{x1}:{y1}',
                f'setpts={duration/source_duration}*(PTS-STARTPTS)', 'fps=30',
                'scale=1216:600:force_original_aspect_ratio=decrease:force_divisible_by=2']
    graph = '[0:v]' + ','.join(filters) + '[clip];[1:v][clip]overlay=x=32+(1216-w)/2:y=100+(600-h)/2:shortest=1[out]'
    ffmpeg('-ss', start, '-t', source_duration, '-i', source,
           '-loop', 1, '-framerate', 30, '-i', background,
           '-filter_complex', graph, '-map', '[out]', '-t', duration,
           '-c:v', 'libx264', '-preset', 'medium', '-crf', 19, '-pix_fmt', 'yuv420p', '-an', output)
    return output, still


def card(temp, previews, ending=False):
    image = Image.new('RGB', SIZE, BG)
    draw = ImageDraw.Draw(image)
    text(draw, (52, 40), 'MOBILE TEST CONSOLE', 20, TEAL)
    text(draw, (52, 89), 'App 与微信小程序', 49)
    text(draw, (52, 160), '从测试启动，到结果与页面证据', 30, '#b6cad6')
    for x, name, preview in [(52, 'APP / 历史测试结果', previews[0]), (663, 'WECHAT / 历史测试结果', previews[1])]:
        draw.rounded_rectangle((x, 242, x + 565, 643), 16, fill='#1d3342')
        text(draw, (x + 20, 259), name, 21, TEAL)
        thumb = ImageOps.contain(preview.crop((32, 100, 1248, 700)), (525, 319), Image.Resampling.LANCZOS)
        image.paste(thumb, (x + 20 + (525-thumb.width)//2, 308 + (319-thumb.height)//2))
    text(draw, (52, 684), '查看 README，开始接入你的项目' if ending else '真实操作剪辑 · App 启动后取消 · 随后展示历史结果', 25)
    text(draw, (52, 742), '设备选择  /  运行状态  /  页面截图  /  接口详情  /  小程序结果', 18, '#98b0bf')
    path = temp / ('ending.png' if ending else 'title.png')
    image.save(path)
    return path, image


def concat(clips, output, temp):
    # 中间文件名由脚本固定产生，列表只记录临时目录内的相对名称。
    manifest = temp / 'concat.txt'
    manifest.write_text(''.join(f"file '{clip.name}'\n" for clip in clips))
    ffmpeg('-f', 'concat', '-safe', 1, '-i', manifest, '-c', 'copy', '-movflags', '+faststart', output)


def make_gif(clips, output, temp):
    # 定格镜头用单帧长延时保存；动态镜头保留 8 fps，避免编码噪声撑大 GIF。
    frames, durations = [], []
    shot_by_name = {shot[0]: shot for shot in SHOTS}
    for clip in clips:
        shot = shot_by_name[clip.stem]
        if shot[3] == 0:
            paths = [temp / f'{clip.stem}-safe.png']
            delays = [int(shot[2] * 1000)]
        else:
            directory = temp / f'{clip.stem}-gif-frames'
            directory.mkdir()
            ffmpeg('-i', clip, '-vf', 'fps=8,scale=1000:625:flags=lanczos', directory / '%04d.png')
            paths = sorted(directory.glob('*.png'))
            # GIF 延时单位为 10ms，交替 120/130ms 保持精确 8 fps。
            delays = [120 if index % 2 == 0 else 130 for index in range(len(paths))]
        for path, delay in zip(paths, delays):
            with Image.open(path) as source_frame:
                rgb = source_frame.convert('RGB').resize((1000, 625), Image.Resampling.LANCZOS)
                frames.append(rgb.quantize(colors=192, method=Image.Quantize.MEDIANCUT))
            durations.append(delay)
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=durations,
                   loop=0, optimize=True, disposal=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='已审阅的原始 MOV 路径')
    parser.add_argument('--output', type=Path, default=ROOT / 'assets/showcase')
    parser.add_argument('--font', type=Path, help='支持中文的字体文件')
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    if not source.is_file():
        parser.error('原始录屏文件不存在')
    digest = hashlib.sha256()
    with source.open('rb') as recording:
        for chunk in iter(lambda: recording.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != SOURCE_SHA256:
        parser.error('该录屏与已审阅的源片不同，请为新素材重新审查时间轴和隐私遮挡')
    for tool in ['ffmpeg', 'ffprobe']:
        if not shutil.which(tool):
            parser.error(f'需要安装 {tool}')
    global FONT
    FONT = args.font or next((Path(p) for p in FONT_CANDIDATES if Path(p).is_file()), None)
    if FONT is None or not FONT.is_file():
        parser.error('请通过 --font 提供中文字体文件')
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(source)]))
    video = next((stream for stream in info['streams'] if stream['codec_type'] == 'video'), {})
    if (video.get('width'), video.get('height')) != (1920, 972) or not 118 <= float(info['format']['duration']) <= 119:
        parser.error('时间轴及隐私遮挡仅适用于已审阅的 1920×972、约 118 秒录屏')
    output = args.output.expanduser().resolve()
    if source in [output / name for name in ['showcase.mp4', 'app-demo.gif', 'wechat-results.gif', 'poster.jpg']]:
        parser.error('输出路径必须与原始录屏分开')
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='mtc-showcase-') as directory:
        temp = Path(directory)
        clips, previews = {}, {}
        for index, shot in enumerate(SHOTS, 1):
            print(f'生成镜头 {index}/{len(SHOTS)}：{shot[0]}', flush=True)
            clips[shot[0]], previews[shot[0]] = render_shot(source, shot, index, temp)
        pair = [previews['overview'], previews['wechat-hold']]
        title_path, poster = card(temp, pair)
        ending_path, _ = card(temp, pair, ending=True)
        title_clip, ending_clip = temp / 'title.mp4', temp / 'ending.mp4'
        encode_still(title_path, 3, title_clip)
        encode_still(ending_path, 3, ending_clip)
        concat([title_clip, *clips.values(), ending_clip], output / 'showcase.mp4', temp)
        poster.save(output / 'poster.jpg', quality=92, optimize=True)
        make_gif([clips[key] for key in ['devices', 'launch', 'cancelled', 'overview', 'screenshots']], output / 'app-demo.gif', temp)
        make_gif([clips[key] for key in ['wechat-target', 'wechat-browse', 'wechat-errors', 'wechat-hold']], output / 'wechat-results.gif', temp)
    print(f'已生成：{output}')


if __name__ == '__main__':
    main()
