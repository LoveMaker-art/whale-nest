"""Numeric client contract. Authentication remains the relay's responsibility."""
PROTOCOL_VERSION = 2
MIN_PROTOCOL_VERSION = 2
CAPABILITIES = ('sse_downstream', 'stream_upload', 'recorder')
# Additive subtitle metadata is safe for the immediately previous v2 page.
COMPATIBLE_BUILDS = frozenset({int('7f28d8dae7da', 16), int('2cfd84563713', 16)})
RELOAD_HINT = '页面版本过旧，请完全关闭后重新打开'


def client_metadata(start):
    def number(value):
        return value if type(value) is int and 0 <= value <= 2 ** 53 - 1 else 0
    caps = start.get('capabilities')
    caps = caps if isinstance(caps, dict) else {}
    return dict(build_id=number(start.get('build_id')), protocol_version=number(start.get('protocol_version')),
                **{key: int(type(caps.get(key)) is int and caps[key] == 1) for key in CAPABILITIES})


def compatible(client, build_id):
    return (client['protocol_version'] >= MIN_PROTOCOL_VERSION and
            client['build_id'] in (COMPATIBLE_BUILDS | {int(build_id, 16)}) and all(client[key] for key in CAPABILITIES))
