"""Constant-size geometry for conventional fixed-length rectangular SEG-Y."""
import struct
import numpy as np

SAMPLE_BYTES = {1:4, 2:4, 3:2, 5:4, 6:8, 8:1, 9:8, 10:4, 11:2, 12:8, 16:1}


class RegularGeometry:
    def __init__(self, parameters):
        for key, value in parameters.items():
            setattr(self, key, int(value))
        self.count = self.inner_count * self.outer_count
        self.il_count = self.inner_count if self.inner_axis == 0 else self.outer_count
        self.xl_count = self.outer_count if self.inner_axis == 0 else self.inner_count
        self.inlines = np.sort(self.il_start + np.arange(self.il_count, dtype=np.int64) * self.il_step)
        self.crosslines = np.sort(self.xl_start + np.arange(self.xl_count, dtype=np.int64) * self.xl_step)

    def parameters(self):
        return {k:np.array(getattr(self,k), dtype=np.int64) for k in ['ns','dt','format','delay','offset','trace_bytes','inner_axis','inner_count','outer_count','il_start','xl_start','il_step','xl_step']}

    def trace_id(self, il, xl):
        i = (np.asarray(il)-self.il_start)//self.il_step
        x = (np.asarray(xl)-self.xl_start)//self.xl_step
        return x*self.inner_count+i if self.inner_axis == 0 else i*self.inner_count+x

    def byte_offset(self, il, xl):
        return self.offset + self.trace_id(il,xl)*self.trace_bytes

    def section_ids(self, mode, number):
        axis = self.inlines if mode == 'inline' else self.crosslines
        if number < axis[0] or number > axis[-1] or (number-int(axis[0])) % abs(self.il_step if mode=='inline' else self.xl_step):
            raise ValueError('Section does not exist in this survey.')
        coords = self.crosslines if mode == 'inline' else self.inlines
        ids = self.trace_id(number,coords) if mode == 'inline' else self.trace_id(coords,number)
        return coords, ids

    def timeslice_grid(self, values):
        grid = values.reshape(self.outer_count,self.inner_count)
        if self.inner_axis == 0:
            grid = grid.T
        if self.il_step < 0:
            grid = grid[::-1,:]
        if self.xl_step < 0:
            grid = grid[:,::-1]
        return grid


def probe_regular(path, ilbyte, xlbyte, report):
    def fail():
        raise ValueError('无法推导固定道长规则网格，请使用 Auto。')
    with open(path, 'rb', buffering=0) as f:
        f.seek(3200); binary = f.read(400)
        if len(binary)!=400: fail()
        ns = struct.unpack_from('>H',binary,20)[0]
        dt = struct.unpack_from('>H',binary,16)[0]
        fmt = struct.unpack_from('>H',binary,24)[0]
        extended = struct.unpack_from('>h',binary,304)[0]
        if ns<1 or fmt not in SAMPLE_BYTES or extended<0: fail()
        offset = 3600 + extended*3200
        trace_bytes = 240 + ns*SAMPLE_BYTES[fmt]
        count, remainder = divmod(path.stat().st_size-offset,trace_bytes)
        if count<1 or remainder: fail()
        seen = {}
        def read(i):
            if i not in seen:
                f.seek(offset+i*trace_bytes)
                header = f.read(240)
                if len(header)!=240: fail()
                seen[i] = (struct.unpack_from('>i',header,ilbyte-1)[0], struct.unpack_from('>i',header,xlbyte-1)[0])
            return seen[i]
        report(10,'探测固定道长与排列方式')
        first=read(0)
        f.seek(offset+108); delay=struct.unpack('>h',f.read(2))[0]
        if count==1:
            inner, n, inner_step, outer_step = 1,1,1,1
        else:
            second=read(1)
            changed=[i for i in range(2) if second[i]!=first[i]]
            if len(changed)!=1: fail()
            inner=changed[0]; outer=1-inner
            inner_step=second[inner]-first[inner]
            low, high=1,2
            # The slow coordinate stays constant throughout the first block.
            while high<count and read(high)[outer]==first[outer]:
                low=high; high*=2
            high=min(high,count)
            report(40,'二分定位首个区块边界')
            while low+1<high:
                mid=(low+high)//2
                if read(mid)[outer]==first[outer]: low=mid
                else: high=mid
            n=high
            if count % n: fail()
            outer_step=read(n)[outer]-first[outer] if n<count else 1
            if not outer_step: fail()
            for i in {n-1, min(n,count-1), count//2, count-1}:
                expected=list(first)
                expected[inner]+=(i%n)*inner_step
                expected[outer]+=(i//n)*outer_step
                if read(i)!=tuple(expected): fail()
        report(85, f'公式几何已建立 · 探测 {len(seen)} 个道头')
        return RegularGeometry(dict(ns=ns,dt=dt,format=fmt,delay=delay,offset=offset,trace_bytes=trace_bytes,
            inner_axis=inner,inner_count=n,outer_count=count//n,il_start=first[0],xl_start=first[1],
            il_step=inner_step if inner==0 else outer_step,xl_step=inner_step if inner==1 else outer_step))
