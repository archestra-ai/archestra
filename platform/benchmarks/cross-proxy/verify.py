import json, pathlib, sys, re
from collections import defaultdict
root=pathlib.Path(sys.argv[1])
roles=['archestra','litellm','litellm-default']
settings=json.loads((root/'profile.json').read_text()) if (root/'profile.json').exists() else {'mode':'primary'}
assert settings['mode'] in ['primary','sensitivity']
sensitivity=settings['mode']=='sensitivity'
repeats=2 if sensitivity else 4
requests=5000 if sensitivity else 10000
stream_requests=1000 if sensitivity else 3000
rows=1+400+requests+stream_requests
memory_gib=8 if sensitivity else 2
if (root/'profile.json').exists():
    assert settings['repeats']==repeats and settings['requests']==requests and settings['streamRequests']==stream_requests
    assert settings['warmup']==200 and settings['databaseMemoryGiB']==memory_gib and settings['freshDatabasePerRun']==sensitivity
db_info=json.loads((root/'archestra-cross-proxy-db-inspect.json').read_text())[0]
assert not db_info['State']['OOMKilled']
assert db_info['HostConfig']['Memory']==memory_gib*1024**3 and db_info['HostConfig']['NanoCpus']==2_000_000_000
observed=defaultdict(list)
response_bytes={False:set(),True:set()}
for role in roles:
    for repeat in range(1,repeats+1):
        result=json.loads((root/f'{role}-{repeat}.json').read_text())
        assert len(result['blocks'])==2
        for block in result['blocks']:
            n=stream_requests if block['streaming'] else requests
            assert block['count']==n and len(block['samples'])==n and block['errors']==0
            for sample in block['samples']:
                assert sample['ok'] and sample['upstream']['user']=='benchmark-user'
                assert sample['upstream']['model']=='gpt-4o-mini'
                assert sample['id']==sample['upstream']['id'] and len(sample['id'])==96
                assert sample['upstream']['usage']=={'prompt_tokens':12,'completion_tokens':20,'total_tokens':32}
                response_bytes[block['streaming']].add(sample['upstream']['responseBytes'])
            observed[role].append({k:v for k,v in block.items() if k!='samples'})
        info=json.loads((root/f'{role}-{repeat}-inspect.json').read_text())[0]
        limits=info['HostConfig']
        assert limits['CpusetCpus']=='2-5' and limits['NanoCpus']==4_000_000_000 and limits['Memory']==8*1024**3
        assert limits['NetworkMode']=='host' and not info['State']['OOMKilled']
        expected=rows if sensitivity else repeat*rows
        content=0 if role=='litellm-default' else expected
        assert (root/f'{role}-{repeat}-accounting.txt').read_text().strip()==f'{expected}|{expected}|{content}'
        if role!='archestra':
            rows=[x.split('|') for x in (root/f'{role}-{repeat}-accounting-status.txt').read_text().strip().splitlines()]
            success=next(x for x in rows if x[0]=='success')
            assert [int(x) for x in success[1:4]]==[expected,expected*12,expected*20]
            assert sum(int(x[1]) for x in rows if x[0]!='success')==(1 if sensitivity else repeat)
assert all(len(v)==1 for v in response_bytes.values())
resources=defaultdict(lambda:{'samples':0,'maxCpuPercent':0,'maxMemoryBytes':0})
units={'B':1,'KiB':1024,'MiB':1024**2,'GiB':1024**3}
for line in (root/'resources.jsonl').read_text().splitlines():
    if not line.startswith('{'): continue
    row=json.loads(line); name=row['Name']; agg=resources[name]
    agg['samples']+=1; agg['maxCpuPercent']=max(agg['maxCpuPercent'],float(row['CPUPerc'].rstrip('%')))
    value,unit=re.fullmatch(r'([\d.]+)([A-Za-z]+)',row['MemUsage'].split(' / ')[0]).groups()
    agg['maxMemoryBytes']=max(agg['maxMemoryBytes'],float(value)*units[unit])
for role in roles: assert resources[f'archestra-cross-proxy-{role}']['samples']>0
upstream=json.loads((root/'upstream-all.json').read_text())
assert len(upstream)==rows*repeats*len(roles)*2 and len({s['id'] for s in upstream})==len(upstream)
assert all(s['user']=='benchmark-user' for s in upstream)
direct=[]
for f in root.glob('direct-*.json'):
    for b in json.loads(f.read_text())['blocks']:
        assert len(b['samples'])==b['count'] and b['errors']==0
        direct.append({k:v for k,v in b.items() if k!='samples'})
assert len(direct)==2*repeats*len(roles)
summary=json.loads((root/'summary.json').read_text())
assert len(summary)==6 and sum(s['samples'] for s in summary)==(requests+stream_requests)*repeats*len(roles) and all(s['errors']==0 for s in summary)
verification={'mode':settings['mode'],'measuredRequests':(requests+stream_requests)*repeats*len(roles),'upstreamRequestsIncludingWarmupProbesAndControls':len(upstream),'responseBytes':{str(k):list(v) for k,v in response_bytes.items()},'allConstantUser':True,'allCorrelationsUnique':True,'allAccountingChecksPassed':True,'allProxyLimitsMatched':True,'noProxyOOM':True,'resourcesWholeProcessLifetime':dict(resources),'directControlBlocks':direct,'profiles':observed}
(root/'verification.json').write_text(json.dumps(verification,indent=2))
print(json.dumps({k:v for k,v in verification.items() if k not in ['directControlBlocks','profiles']},indent=2))
