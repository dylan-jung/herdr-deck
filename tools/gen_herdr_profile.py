import json, uuid, os, glob

base = os.path.expanduser('~/Library/Application Support/Ulanzi/UlanziDeck')
PLUG = f'{base}/Plugins/com.ulanzi.herdrstatus.ulanziPlugin'
PROFILE_ID = 'YOUR-PROFILE-ID'

def space_status(n):
    return {"Action": f"com.ulanzi.ulanzistudio.herdrstatus.space{n}",
            "ActionID": str(uuid.uuid4()),
            "ActionParam": {"index": n},
            "LinkedTitle": True, "Name": "Herdr Space",
            "Plugin": {"Name": "Herdr", "UUID": "com.ulanzi.ulanzistudio.herdrstatus", "Version": "1.1.0"},
            "State": 0,
            "ViewParam": [{"Icon": f'{PLUG}/resources/state_unknown_{n}.png', "IconRel": "", "Text": f"Space {n}"}]}

def cmd(label, op):
    return {"Action": f"com.ulanzi.ulanzistudio.herdrstatus.{op}",
            "ActionID": str(uuid.uuid4()),
            "ActionParam": {"op": op},
            "LinkedTitle": True, "Name": label,
            "Plugin": {"Name": "Herdr", "UUID": "com.ulanzi.ulanzistudio.herdrstatus", "Version": "1.1.0"},
            "State": 0,
            "ViewParam": [{"Icon": f'{PLUG}/resources/{op}.png' if op != "session_label" else f'{PLUG}/resources/label_local.png', "IconRel": "", "Text": label if op != "session_label" else ""}]}

def build_page(session=None):
    def S(d):
        if session: d["ActionParam"]["session"] = session
        return d
    keys = {}
    for i in range(4):
        keys[f"{i}_0"] = S(space_status(i + 1))
    keys["4_0"] = S(cmd("새 스페이스", "new_space"))
    row1 = [("세로 분할", "split_v"), ("가로 분할", "split_h"), ("창 닫기", "close_pane"), ("줌", "zoom_pane"), ("Lazygit", "lazygit")]
    for i, (label, op) in enumerate(row1):
        keys[f"{i}_1"] = S(cmd(label, op))
    for i, (label, op) in enumerate([("호출 응답", "jump_blocked"), ("워크트리", "new_worktree"), ("워크트리 정리", "remove_worktree")]):
        keys[f"{i}_2"] = S(cmd(label, op))
    knobs = {"2_3": S(cmd("herdr 탭", "knob_tabs")),
             "3_3": S(cmd("에이전트", "knob_agents")),
             "4_3": S(cmd("스페이스", "knob_spaces"))}
    return {"Controllers": [{"Actions": knobs, "Type": "Encoder"},
                            {"Actions": keys, "Type": "Keypad"}],
            "Icon": "", "Name": session or "local"}

for mf in glob.glob(f'{base}/ProfilesV2/*.ulanziProfile/manifest.json'):
    if PROFILE_ID not in mf:
        continue
    m = json.load(open(mf))
    pdir = os.path.dirname(mf)
    pages = m['Pages']['Pages']
    cfg = json.load(open(f'{PLUG}/sessions.json'))
    SESS = [None] + list(cfg.get('sessions', {}).keys())
    while len(pages) < len(SESS):
        pages.append(str(uuid.uuid4()))
    json.dump(m, open(mf, 'w'), ensure_ascii=False, indent=1)
    for page_id, sess in zip(pages, SESS):
        os.makedirs(f'{pdir}/Profiles/{page_id}', exist_ok=True)
        out = f'{pdir}/Profiles/{page_id}/manifest.json'
        page = build_page(sess)
        for c in page['Controllers']:  # stable ActionIDs so reruns don't strand the app's in-memory IDs
            for pos, a in c['Actions'].items():
                seed = f"herdr-deck:{sess or 'local'}:{c['Type']}:{pos}:{a['Action']}"
                a['ActionID'] = str(uuid.uuid5(uuid.NAMESPACE_URL, seed))
        try:  # keep app-managed / user-assigned entries we don't own, on every controller type
            prev = json.load(open(out))
            by_type = {c['Type']: c for c in page['Controllers']}
            for pc in prev['Controllers']:
                tgt = by_type.get(pc['Type'])
                if not tgt:
                    continue
                for pos, a in pc['Actions'].items():
                    if not str(a.get('Action', '')).startswith('com.ulanzi.ulanzistudio.herdrstatus'):
                        tgt['Actions'][pos] = a
        except Exception:
            pass
        json.dump(page, open(out, 'w'), ensure_ascii=False, indent=1)
        print('written:', sess or 'local', out)
