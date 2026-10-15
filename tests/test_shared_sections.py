"""Shared Trace/TWT reconstruction, native cells and publication profile state."""
import io
import numpy as np
import pytest
from PIL import Image
from backend import resample
from backend.models import HorizonMapState, Seismic, Settings, ViewState, ViewState3D, SectionRequest, HorizonProfileRequest
from backend.section_service import interactive_section
from backend.scene import scene_data
from backend.horizon_map import map_profile, render_profile, _profile_data


@pytest.mark.parametrize('background', [False, True])
@pytest.mark.parametrize('wiggle_interpolation', [False, True])
def test_vertical_3d_slice_matches_2d_samples_and_trace_paths(cube, background, wiggle_interpolation):
    seismic = Seismic(background_interpolation=background, wiggle_interpolation=wiggle_interpolation,
                      wiggle=True, variable_area=True, wiggle_gain=.6, clip_mode='manual', vmin=-2000, vmax=2000)
    state = ViewState3D(seismic=seismic, slices={'inline':[{'id':'il','position':10}]},
                        scene={'quality':128, 'slice_viewports':{'il':(120,80)}})
    data = scene_data(cube, {}, state)
    section = interactive_section(cube, {}, SectionRequest(section_number=10, seismic=seismic,
                                  target_width=120, target_height=80, trace_viewport_width=120, trace_viewport_height=80))
    plane = data['slices'][0]
    assert plane['amplitude'] == section['z']
    assert plane['a_edges'] == section['x_edges'] and plane['b_edges'] == section['time_edges']
    assert plane['trace_overlay'] == section['trace_overlay']
    assert (data['vmin'], data['vmax']) == (section['vmin'], section['vmax'])
    assert plane['interpolation'] == ('sinc8' if background else 'native')


def test_new_3d_and_profile_flows_never_use_legacy_bicubic(cube, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('legacy image resampling was used on shared seismic amplitudes')
    monkeypatch.setattr(resample, 'resample', forbidden)
    data = scene_data(cube, {}, ViewState3D(seismic={'interpolation':'bicubic'},
                      slices={'inline':[{'id':'il','position':10}], 'time':[{'id':'t','position':204}]},
                      scene={'quality':128, 'slice_viewports':{'il':(120,80),'t':(120,80)}}))
    assert [p['interpolation'] for p in data['slices']] == ['sinc8', 'linear']
    profile = map_profile(cube, None, HorizonMapState(horizon='h'), {}, (10,30), (12,38),
                          120,80,'bicubic', ViewState(section_number=0))
    assert profile['interpolation'] == 'sinc8'


def test_native_3d_fixed_twt_and_profile_keep_original_samples(cube, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('interpolation disabled, but amplitude reconstruction was called')
    monkeypatch.setattr(resample, 'seismic_raster', forbidden)
    seismic = Seismic(background_interpolation=False, wiggle_interpolation=False)
    data = scene_data(cube, {}, ViewState3D(seismic=seismic,
                      slices={'inline':[{'id':'il','position':10}], 'time':[{'id':'t','position':204}]},
                      scene={'quality':128, 'slice_viewports':{'il':(8,8),'t':(8,8)}}))
    assert data['slices'][0]['amplitude'] == cube.section('inline',10)[2].tolist()
    np.testing.assert_array_equal(data['slices'][1]['amplitude'],
        np.stack([cube.section('inline', int(il))[2][1] for il in cube.inlines]))
    profile = _profile_data(cube, HorizonMapState(horizon='h'), {}, (10,30),(12,38),
                            120,80, display_state=ViewState(section_number=0,seismic=seismic))
    np.testing.assert_array_equal(profile['amplitude'], profile['native_amplitude'])
    assert profile['trace_overlay'] is None


def test_shared_clip_range_and_polarity_do_not_depend_on_render_resolution(cube):
    seismic = Seismic(wiggle=True, variable_area=True, reverse_polarity=True)
    def scene(width):
        return scene_data(cube, {}, ViewState3D(seismic=seismic,
                          slices={'inline':[{'id':'a','position':10}]},
                          scene={'quality':128,'slice_viewports':{'a':(width,80)}}))
    low, high = scene(32), scene(120)
    assert (low['vmin'],low['vmax']) == (high['vmin'],high['vmax'])
    assert high['slices'][0]['trace_overlay']['variable_area']['x'] == []
    assert min(v for v in high['slices'][0]['trace_overlay']['wiggle']['x'] if v is not None) < 30


def test_repeated_profile_settings_and_zoom_reuse_native_path(cube, monkeypatch):
    from backend import horizon_map
    native_calls=[]
    original=horizon_map.sample_seismic_line
    def sampled(*args):
        native_calls.append(True)
        return original(*args)
    monkeypatch.setattr(horizon_map,'sample_seismic_line',sampled)
    base=ViewState(section_number=0)
    args=(cube,None,HorizonMapState(horizon='h'),{},(10,30),(12,38))
    first=map_profile(*args, target_width=120,target_height=80,display_state=base)
    second=map_profile(*args, target_width=120,target_height=80,display_state=base)
    assert first==second
    zoom=base.model_copy(update={'x_range':(2,4),'time_range':(204,208),
                        'seismic':base.seismic.model_copy(update={'wiggle':True,'variable_area':True})})
    result=map_profile(*args,target_width=120,target_height=80,display_state=zoom)
    assert result['raster_extent']==[2,4,204,208]
    assert result['trace_overlay'] is not None
    assert len(native_calls)==1
    assert (first['vmin'],first['vmax']) == (result['vmin'],result['vmax'])


@pytest.mark.parametrize('background',[False,True])
def test_profile_export_honors_shared_sampling_aspect_and_layers(cube, monkeypatch, background):
    from backend import horizon_map
    captured=[]
    original=horizon_map.save_figure
    def save(fig,settings,rasters,colorbars):
        captured.append((fig.axes[0],rasters))
        return original(fig,settings,rasters,colorbars)
    monkeypatch.setattr(horizon_map,'save_figure',save)
    state=ViewState(section_number=0,aspect_ratio_2d=(3,1),trace_viewport_width=300,trace_viewport_height=200,
                    seismic=Seismic(background_interpolation=background,wiggle=True,variable_area=True,
                                    clip_mode='manual',vmin=-2000,vmax=2000))
    content,_=render_profile(cube,HorizonMapState(horizon='h',colorbar=False),{},(10,30),(12,38),
                    Settings(canvas='fit',long_edge=900,background='transparent'),display_state=state)
    ax,rasters=captured[0]
    assert ax.get_box_aspect()==pytest.approx(1/3)
    assert bool(rasters)==background
    from matplotlib.collections import LineCollection,PolyCollection
    assert any(isinstance(c,LineCollection) and c.get_zorder()==2 for c in ax.collections)
    assert any(isinstance(c,PolyCollection) and c.get_zorder()==1 for c in ax.collections)
    image=Image.open(io.BytesIO(content)).convert('RGBA')
    assert image.getpixel((0,0))[3]==0
    assert image.width==900 and image.width>2*image.height


def test_profile_and_scene_models_validate_display_ranges_and_defaults():
    state=HorizonProfileRequest(state={'horizon':'h'},a=(10,30),b=(12,38)).section_state()
    assert not state.seismic.wiggle and not state.seismic.variable_area
    assert state.seismic.background_interpolation and state.seismic.wiggle_interpolation
    with pytest.raises(ValueError):
        HorizonProfileRequest(state={'horizon':'h'},a=(10,30),b=(12,38),time_range=(208,204))
    with pytest.raises(ValueError):
        ViewState3D(scene={'slice_viewports':{'a':(float('nan'),100)}})


def test_profile_horizon_geometry_does_not_follow_background_interpolation_or_zoom(cube, horizon):
    args=(cube,None,HorizonMapState(horizon='h'),{'h':horizon},(10,30),(12,38))
    native=map_profile(*args,display_state=ViewState(section_number=0,seismic={'background_interpolation':False}))
    sampled=map_profile(*args,target_width=120,target_height=80,
                       display_state=ViewState(section_number=0,x_range=(2,4),time_range=(204,208)))
    assert native['curve_distance']==sampled['curve_distance']
    assert native['curves']==sampled['curves']


def test_profile_export_reuses_visible_2d_horizon_styles(cube, horizon, monkeypatch):
    from backend import horizon_map
    from backend.models import HorizonStyle
    captured=[]
    def save(fig,*args):
        captured.append(fig.axes[0]);return b'checked'
    monkeypatch.setattr(horizon_map,'save_figure',save)
    style=HorizonStyle(id='h',name='Visible',color='#123456',line={'width':2,'style':'dashed'},
                       marker={'visible':True,'shape':'diamond','size':4},outline={'width':.8})
    invisible=HorizonStyle(id='hidden',name='Hidden',visible=False)
    _,info=render_profile(cube,HorizonMapState(horizon='h',colorbar=False),{'h':horizon,'hidden':horizon},
                         (10,30),(12,38),Settings(canvas='fit',long_edge=600),
                         horizon_styles=[style,invisible],show_ab=False)
    ax=captured[0]
    assert len(ax.lines)==3
    assert ax.lines[0].get_linewidth()==pytest.approx(3.6)
    assert ax.lines[1].get_color()=='#123456' and ax.lines[1].get_linestyle()=='--'
    assert ax.lines[2].get_marker()=='D'
    assert len(info['curves'])==1
    assert ax.get_legend() is not None
    assert all(line.get_zorder()==3 for line in ax.lines)
    assert ax.xaxis.get_zorder()==4


def test_profile_queue_records_display_and_furniture_state(client):
    import backend.export_queue as queue
    response=client.post('/api/export/queue',json={
        'kind':'profile','state':{'horizon':'h','colorbar':False},'a':[10,30],'b':[12,38],
        'seismic':{'background_interpolation':False,'wiggle_interpolation':False,'wiggle':True,
                   'variable_area':True,'wiggle_gain':.8,'reverse_polarity':True},
        'aspect_ratio_2d':[3,1],'x_range':[1,6],'time_range':[204,212],
        'horizons':[{'id':'h','name':'H','visible':False}],
        'show_curves':False,'show_legend':False,'show_ab':False,
        'settings':{'canvas':'fit','long_edge':600,'background':'transparent'},
    })
    assert response.status_code==200,response.text
    manifest=queue.session().manifest()['figures'][0]
    assert manifest['seismic']['background_interpolation'] is False
    assert manifest['seismic']['wiggle_gain']==.8
    assert list(manifest['aspect_ratio_2d'])==[3,1] and list(manifest['time_range'])==[204,212]
    assert manifest['show_curves'] is False and manifest['show_legend'] is False and manifest['show_ab'] is False
    assert manifest['horizons'][0]['visible'] is False
