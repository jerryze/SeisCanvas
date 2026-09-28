import {Download, LoaderCircle, X} from 'lucide-react';
import {Num, Toggle} from './Controls';

type Props = {
  title:string; settings:any; onChange:(patch:any)=>void; onClose:()=>void;
  onExport:()=>void; busy:boolean; disabled?:boolean; error?:string;
  scene?:boolean; colorbar?:boolean; onColorbar?:(value:boolean)=>void;
};
export default function ExportDialog({title,settings:s,onChange:patch,onClose,onExport,busy,disabled,error,scene=false,colorbar,onColorbar}:Props) {
  const axes=s.show_axes!==false;
  return <div className="modal-backdrop" onClick={()=>!busy&&onClose()}>
    <div className="modal export-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}>
      <div className="modal-heading"><div><span className="eyebrow">EXPORT FIGURE</span><h2>{title}</h2></div><button className="icon" title="关闭导出" disabled={busy} onClick={onClose}><X size={20}/></button></div>
      <fieldset className="export-settings" disabled={busy}>
        <section><h3>文件格式</h3><div className="format-options compact">{['png','pdf','svg'].map(format=><button key={format} aria-pressed={s.format===format} className={s.format===format?'active':''} onClick={()=>patch({format})}>{format.toUpperCase()}</button>)}</div></section>
        <section><h3>尺寸与清晰度</h3><div className="field-row">
          <label>宽度 · {scene?'px':'mm'}<Num value={s.width} min={scene?400:40} max={scene?4000:500} onChange={width=>patch({width})}/></label>
          <label>高度 · {scene?'px':'mm'}<Num value={s.height} min={scene?300:30} max={scene?4000:500} onChange={height=>patch({height})}/></label>
          <label>{scene?'分辨率倍率':'DPI'}<select value={scene?s.scale:s.dpi} onChange={e=>patch(scene?{scale:+e.target.value}:{dpi:+e.target.value})}>{(scene?[1,2,3,4]:[300,600]).map(n=><option key={n} value={n}>{n}{scene?'×':''}</option>)}</select></label>
        </div></section>
        <section><h3>文字样式</h3><div className="field-row"><label>字体<select value={s.font} onChange={e=>patch({font:e.target.value})}>{['DejaVu Sans','DejaVu Serif','Arial','Times New Roman'].map(f=><option key={f}>{f}</option>)}</select></label><label>字号 · pt<Num value={s.font_size} min={5} max={30} onChange={font_size=>patch({font_size})}/></label></div></section>
        <section><h3>图面元素</h3><div className="export-toggles">
          <Toggle label="显示坐标轴" checked={axes} onChange={show_axes=>patch({show_axes})}/>
          <fieldset disabled={!axes}><Toggle label="显示轴标签" checked={scene?s.show_axis_labels:s.show_labels} onChange={value=>patch(scene?{show_axis_labels:value}:{show_labels:value})}/></fieldset>
          {scene?<Toggle label="显示包围盒" checked={s.show_bounding_box} onChange={show_bounding_box=>patch({show_bounding_box})}/>:<Toggle label="显示标题" checked={s.show_title} onChange={show_title=>patch({show_title})}/>}
          {onColorbar&&<Toggle label="显示色标尺" checked={!!colorbar} onChange={onColorbar}/>}
        </div>
        {scene&&<label className="field">背景颜色<input aria-label="导出背景颜色" type="color" value={s.background} onChange={e=>patch({background:e.target.value})}/></label>}</section>
      </fieldset>
      {error&&<div className="error" role="alert">{error}</div>}
      <div className="export-actions"><button className="secondary" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||disabled} onClick={onExport}>{busy?<LoaderCircle className="spin" size={16}/>:<Download size={16}/>} {busy?'正在导出…':`导出 ${s.format.toUpperCase()}`}</button></div>
    </div>
  </div>;
}
