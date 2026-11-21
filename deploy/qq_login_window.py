"""Narrow X11 control for the pinned Linux QQ 3.2.34 login window.

Only the managed process and known login geometry can be captured. A retry
may dismiss the one verified informational restriction and cancel the old
scanned attempt. Unknown dialogs and security authorization are never clicked.
"""
import struct
import subprocess
import zlib
import hashlib

SAVED_LOGIN_BUTTON = '004895ca94c73395a408d10a4555e432b6212b5baf298fc7781e1dcd6bbb4ece'
SAVED_LOGIN_FOOTER = 'ff723c122f1ec28c534fc5e442c6c1eb4b8fde9daf452c3a3c7ebee7b60cf746'
SCAN_LOGIN_FOOTER = '7a7ee28fbabfa4136eeed2e6fe528b0c7c8950cf53da0fe08113820956956df6'
ADD_ACCOUNT_LABEL = '6fd7f92d60bea03d940dc757c57ed1d345b5b78611a371000bc7c429dcca9c83'
WIDE_ADD_ACCOUNT_SYMBOL = 'bc1ce3b2b5a95cb85b784f3b9b7d172866cc077d72b05058377d23813979b39f'
WIDE_OTHER_LOGIN_LABEL = 'ca0d7a4f98d6ad0442d9865e4951eaf52817c1bbf96b5e083210c47ebdf4990c'
WIDE_ACCOUNT_MANAGEMENT_LABEL = 'e4fa9bce564d2069602d43b633f87c8ee222793303d215a203169e3f323abcb9'
WIDE_SCAN_INSTRUCTION = '4fdef772b96f13d1c3e675c680bd6fb262aeddb131e19dde628af065a61f04b2'
WIDE_EXPIRED_LABEL = '38517bd0ce623c7023d3975af13f0b323427e4e00b8afeefa81205792ff2f948'
WIDE_REFRESH_LABEL = 'c2b1e3b50aedc9c758dc54bd2cdf1d4f6d057422c21d71b1f9e308fa322ce1ab'
WIDE_REFRESH_HOVERED_LABEL = 'ca2078a0eac2f8782c01c1c3d38e62b86f22d4e11ab7ee2ff0ede86afe310d27'
LOGIN_SIZES = {(320, 460), (640, 424)}

RISK_MESSAGE_MASK = '37b9ecf75c4b35f011c1f99e02ba22d15a286ae9768c377f329b9dc6980cbd80'


def png(rgb, width, height):
    def chunk(name, data):
        return struct.pack('!I', len(data)) + name + data + struct.pack('!I', zlib.crc32(name + data))
    rows = b''.join(b'\0' + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def classify(rgb, width=320, height=460):
    if (width, height) not in LOGIN_SIZES or len(rgb) != width * height * 3:
        return 'unavailable'

    def pixel(x, y):
        i = (y * width + x) * 3
        return rgb[i:i + 3]

    def gray(x, y):
        return sum(pixel(x, y)) / 3

    def mask(x0, y0, x1, y1, *, blue=False, dark=False, red=False):
        def ink(x, y):
            r, g, b = pixel(x, y)
            if dark:
                return max(r, g, b) < 160
            if red:
                return r > 180 and g < 140 and b < 150 and r - g > 80
            return b > r + 32 and b > g + 15 and r < 210 if blue else min(r, g, b) > 230
        return hashlib.sha256(bytes(ink(x, y) for y in range(y0, y1)
                                    for x in range(x0, x1))).hexdigest()

    if (width, height) == (640, 424):
        if (mask(441, 135, 478, 172, dark=True) == WIDE_ADD_ACCOUNT_SYMBOL
                and mask(243, 379, 323, 398, blue=True) == WIDE_OTHER_LOGIN_LABEL
                and mask(342, 379, 395, 398, blue=True) == WIDE_ACCOUNT_MANAGEMENT_LABEL):
            return 'wide-saved-account'
        if mask(441, 303, 574, 342, dark=True) == WIDE_SCAN_INSTRUCTION:
            if (mask(466, 187, 550, 205, red=True) == WIDE_EXPIRED_LABEL
                    and mask(490, 211, 525, 244, dark=True) in (WIDE_REFRESH_LABEL, WIDE_REFRESH_HOVERED_LABEL)):
                return 'expired'

            def colored(x, y):
                r, _, b = pixel(x, y)
                return b - r > 45 and b > 190

            def finder(x, y):
                # The wide layout uses colored rings instead of square finders.
                return colored(x, y) and all(
                    min(pixel(x + dx * 8, y + dy * 8)) >= 235
                    and any(colored(x + dx * d, y + dy * d) for d in range(10, 15))
                    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)))

            if (all(finder(x, y) for x, y in ((454, 162), (560, 162), (454, 269)))
                    and sum(colored(x, y) for x in range(478, 549) for y in range(186, 248)) >= 600):
                return 'waiting'
        return 'unavailable'

    if mask(90, 412, 228, 433, blue=True) == SCAN_LOGIN_FOOTER:
        return 'scan-link'

    logo = sum(1 for y in range(45, 76) for x in range(130, 190)
               if pixel(x, y)[2] > pixel(x, y)[0] + 18 and pixel(x, y)[2] > 75)
    if logo < 30:
        return 'unavailable'
    # Recognize only the observed static message with the pinned QQ/font build.
    # A changed/unknown message stays read-only, including verification dialogs.
    if sum(gray(x, y) for x, y in ((8, 50), (312, 50), (8, 420))) / 3 < 190:
        mask = bytes(1 if gray(x, y) < 210 else 0 for y in range(195, 258) for x in range(35, 285))
        if hashlib.sha256(mask).hexdigest() == RISK_MESSAGE_MASK:
            return 'security-restricted'
        return 'attention-required'
    # Static labels only. The remembered nickname, avatar and visible QQ
    # number do not identify or authorize the account.
    if mask(90, 412, 228, 433, blue=True) == SAVED_LOGIN_FOOTER:
        if mask(69, 314, 129, 336, blue=True) == ADD_ACCOUNT_LABEL:
            return 'account-picker'
        if mask(144, 315, 176, 340, blue=False) == SAVED_LOGIN_BUTTON:
            return 'saved-account'
    finders = ((86, 170), (233, 170), (86, 317))
    rendered = all(all(gray(x + dx, y) < 140 for dx in (-15, 0, 15))
                   and all(gray(x + dx, y) > 180 for dx in (-20, -10, 10, 20))
                   for x, y in finders)
    if rendered:
        return 'waiting'
    blue = sum(1 for y in range(304, 317) for x in range(122, 135)
               if pixel(x, y)[2] > 220 and 80 < pixel(x, y)[1] < 220 and pixel(x, y)[0] < 140)
    if blue >= 45 and all(gray(x, y) > 220 for x, y in ((116, 310), (116, 298), (128, 298), (128, 322))):
        return 'scanned'
    # QQ fades the old finders and displays a wide red expiration label and a
    # white outlined refresh button. A colored avatar alone does not match.
    red_columns = set()
    for y in range(230, 253):
        for x in range(80, 241):
            r, g, b = pixel(x, y)
            if r > 180 and g < 140 and b < 150 and r - g > 80:
                red_columns.add(x)
    faded = all(gray(x, y) > 200 for x, y in finders)
    white_button = all(gray(x, y) > 225 for x, y in ((130, 278), (190, 278), (160, 266)))
    return 'expired' if faded and len(red_columns) >= 45 and white_button else 'preparing'


class QQLoginWindow:
    def __init__(self, root, env, pid):
        self.root, self.env, self.pid = root, env, pid
        self.window_id = None

    def run(self, args, timeout=6):
        return subprocess.run(args, env=self.env, capture_output=True, check=True, timeout=timeout).stdout

    def geometry(self):
        xd = str(self.root / 'usr/bin/xdotool')
        try:
            ids = self.run([xd, 'search', '--onlyvisible', '--pid', str(self.pid)]).decode().split()
        except subprocess.CalledProcessError:
            return None
        candidates = []
        for wid in ids:
            if not wid.isdigit():
                continue
            if self.window_id is not None and wid != self.window_id:
                continue
            owner = self.run([xd, 'getwindowpid', wid]).decode().strip()
            if owner != str(self.pid):
                continue
            fields = dict(line.split('=', 1) for line in self.run([xd, 'getwindowgeometry', '--shell', wid]).decode().splitlines() if '=' in line)
            size = int(fields['WIDTH']), int(fields['HEIGHT'])
            if size in LOGIN_SIZES:
                candidates.append((wid, int(fields['X']), int(fields['Y']), *size))
        return candidates[0] if len(candidates) == 1 else None

    def inspect(self):
        geometry = self.geometry()
        if geometry is None:
            return {'state': 'unavailable'}
        wid, x, y, width, height = geometry
        if x < 0 or y < 0 or x + width > 1024 or y + height > 768:
            return {'state': 'unavailable'}
        rgb = self.run([str(self.root / 'usr/bin/ffmpeg'), '-hide_banner', '-loglevel', 'error',
                        '-f', 'x11grab', '-draw_mouse', '0', '-video_size', f'{width}x{height}', '-i', f':99+{x},{y}',
                        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
        state = classify(rgb, width, height)
        if state in ('waiting', 'expired', 'scanned', 'security-restricted', 'saved-account', 'wide-saved-account', 'account-picker', 'scan-link'):
            self.window_id = wid
        result = {'state': state, 'geometry': geometry}
        if state == 'waiting':
            left, top, side = (427, 135, 160) if width == 640 else (56, 140, 208)
            crop = b''.join(rgb[((top + row) * width + left) * 3:((top + row) * width + left + side) * 3]
                            for row in range(side))
            result['image'] = png(crop, side, side)
        elif width == 320 and state in ('attention-required', 'expired', 'security-restricted', 'preparing', 'saved-account', 'account-picker'):
            result['attentionImage'] = png(rgb, width, height)
        return result

    def refresh(self, frame):
        x, y = (507, 227) if frame['geometry'][3:] == (640, 424) else (160, 279)
        self._click(frame, 'expired', x, y)

    def dismiss_security_notice(self, frame):
        # This X closes an informational failure, not phone authorization.
        self._click(frame, 'security-restricted', 288, 142)

    def cancel_scanned(self, frame):
        self._click(frame, 'scanned', 160, 422)

    def _click(self, frame, expected, x, y):
        # Recheck ownership and location immediately before this single action.
        if frame.get('state') != expected or self.geometry() != frame.get('geometry'):
            raise RuntimeError('QQ action requires its verified login layout')
        current = self.inspect()
        if current.get('state') != expected or current.get('geometry') != frame.get('geometry'):
            raise RuntimeError('QQ login window changed before refresh')
        wid = frame['geometry'][0]
        self.run([str(self.root / 'usr/bin/xdotool'), 'mousemove', '--window', wid,
                  str(x), str(y), 'click', '--clearmodifiers', '1'])

    def prepare(self, frame, attempt):
        state = frame['state']
        if state == 'wide-saved-account':
            if not attempt.get('addAccountClicked'):
                self._click(frame, 'wide-saved-account', 460, 153)
                self.window_id = None  # QQ may open the sign-in form in a new window.
                attempt.update(addAccountClicked=True, changed=True)
                return {'state': 'preparing', 'action': 'add-account'}
            return {'state': 'preparing'}
        if state == 'saved-account':
            if not attempt.get('accountPickerOpened'):
                self._click(frame, 'saved-account', 160, 234)
                attempt['accountPickerOpened'] = True
                return {'state': 'preparing', 'action': 'open-account-picker'}
            return {'state': 'preparing'}
        if state == 'account-picker':
            if not attempt.get('addAccountClicked'):
                self._click(frame, 'account-picker', 100, 325)
                attempt.update(addAccountClicked=True, changed=True)
                return {'state': 'preparing', 'action': 'add-account'}
            return {'state': 'preparing'}
        if state == 'scan-link':
            if not attempt.get('scanLoginClicked'):
                self._click(frame, 'scan-link', 121, 422)
                attempt.update(scanLoginClicked=True, changed=True)
                return {'state': 'preparing', 'action': 'open-scan-login'}
            return {'state': 'preparing'}
        if state == 'security-restricted':
            if attempt.get('riskDismissed'):
                return {'state': state, 'done': True}
            self.dismiss_security_notice(frame)
            attempt.update(riskDismissed=True, restartScanned=True, changed=True)
            return {'state': 'preparing', 'action': 'dismiss-known-failure'}
        if state == 'scanned':
            if not (attempt.get('refresh') or attempt.get('restartScanned')):
                return {'state': state, 'done': True}
            if not attempt.get('cancelled'):
                self.cancel_scanned(frame)
                attempt.update(cancelled=True, changed=True)
                return {'state': 'preparing', 'action': 'cancel-old-scan'}
            return {'state': 'preparing'}
        if state == 'expired':
            if not attempt.get('refreshClicked'):
                self.refresh(frame)
                attempt.update(refreshClicked=True, changed=True)
                return {'state': 'preparing', 'action': 'refresh-expired-code'}
            return {'state': 'preparing'}
        return {'state': state, 'done': state in ('waiting', 'attention-required')}
