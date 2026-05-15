from dataclasses import dataclass
from typing import List, Generator, Tuple, Set, Dict

from mahjong.constants import MahjongSplitChar
from .common import char_to_number, number_to_char

@dataclass
class RawPositionWithSuitData:
    x: int # 行
    y: int # 列
    z: int # 层
    suit: str = '' # 花色

    @staticmethod
    def iter_pos_from_position_data(position_data: str) -> Generator[Tuple[int, int, int], None, None]:
        layer_data_list = position_data.split(MahjongSplitChar.LAYER_SPLIT_CHAR)
        for layer_data in layer_data_list:
            layer_num = char_to_number(layer_data[0])
            row_data_list = layer_data[1:].split(MahjongSplitChar.ROW_SPLIT_CHAR)
            for row_data in row_data_list:
                row_num = char_to_number(row_data[0])
                column_data_list = row_data[1:].split(MahjongSplitChar.COLUMN_SPLIT_CHAR)
                for column_data in column_data_list:
                    column_num = char_to_number(column_data)
                    yield row_num, column_num, layer_num

    @staticmethod
    def iter_suit_from_suit_data(suit_data: str) -> Generator[str, None, None]:
        for suit_data in suit_data:
            yield suit_data

    @staticmethod
    def from_level_str(level_str: str) -> List["RawPositionWithSuitData"]:
        """ 从level_str中拆分出RawPositionWithSuitData """
        position_data, suit_data = level_str.split(MahjongSplitChar.POSIT_SUIT_SPLIT_CHAR)
        if suit_data:
            return [
                RawPositionWithSuitData(x, y, z, suit) for (x, y, z), suit in 
                zip(RawPositionWithSuitData.iter_pos_from_position_data(position_data), RawPositionWithSuitData.iter_suit_from_suit_data(suit_data))
            ]
        else:
            return [RawPositionWithSuitData(x, y, z) for x, y, z in RawPositionWithSuitData.iter_pos_from_position_data(position_data)]

    @staticmethod
    def to_level_str(data_list: List["RawPositionWithSuitData"]) -> str:
        """ 将RawPositionWithSuitData转换为level_str """
        has_suit = any(data.suit for data in data_list)
        position_str = PositionDataFormatter().format(data_list=data_list)
        if has_suit:
            suit_str = ''.join(data.suit for data in data_list)
            return f"{position_str}{MahjongSplitChar.POSIT_SUIT_SPLIT_CHAR}{suit_str}"
        else:
            return position_str

    @staticmethod
    def sort(data_list: List["RawPositionWithSuitData"]) -> List["RawPositionWithSuitData"]:
        """ 将RawPositionWithSuitData按x,y,z排序 """
        return sorted(data_list, key=lambda data: (data.z, data.x, data.y))

class PositionDataFormatter:
    """
    麻将位置数据格式化工具类
    
    功能：
    - 处理三维坐标数据（层、行、列）
    - 添加适当的分隔符
    - 处理花色信息
    - 检测并防止重复坐标
    """
    
    @dataclass
    class _CoordinateState:
        """内部坐标状态数据类，用于跟踪每个坐标维度的状态"""
        last: int = None
        seen: Set[int] = None
        first: bool = True

        def __post_init__(self):
            if self.seen is None:
                self.seen = set()
    
    def __init__(self):
        self._separators = {
            'layer': MahjongSplitChar.LAYER_SPLIT_CHAR,
            'row': MahjongSplitChar.ROW_SPLIT_CHAR,
            'column': MahjongSplitChar.COLUMN_SPLIT_CHAR,
            'position_suit': MahjongSplitChar.POSIT_SUIT_SPLIT_CHAR
        }
        
    def format(self, data_list: List[RawPositionWithSuitData]) -> str:
        """
        格式化位置数据
        
        Args:
            data_list: 包含 RawPositionWithSuitData 对象的列表
            
        Returns:
            格式化后的字符串
            
        Raises:
            ValueError: 如果检测到重复的层、行或列
        """
        state = {
            'layer': self._CoordinateState(),
            'row': self._CoordinateState(),
            'column': self._CoordinateState()
        }
        
        str_list = []
        
        for data in data_list:
            self._process_coordinate('layer', data.z, state, str_list)
            self._process_coordinate('row', data.x, state, str_list)
            self._process_coordinate('column', data.y, state, str_list)
        
        position_data = ''.join(str_list)
        return position_data
    
    def _process_coordinate(self, coord_type: str, value: int, 
                          state: Dict[str, '_CoordinateState'], str_list: List[str]) -> None:
        """
        处理单个坐标变更
        
        Args:
            coord_type: 坐标类型（'layer', 'row' 或 'column'）
            value: 坐标值
            state: 包含所有状态信息的字典
            str_list: 用于构建字符串的列表
            
        Raises:
            ValueError: 如果检测到重复坐标
        """
        coord_state = state[coord_type]
        
        if value == coord_state.last:
            return  # 坐标未变化
        
        if value in coord_state.seen:
            raise ValueError(f"{coord_type}重复: {value}")
        
        # 添加分隔符（如果不是第一个）
        if not coord_state.first:
            str_list.append(self._separators[coord_type])
        else:
            coord_state.first = False
        
        # 更新状态和字符串列表
        coord_state.seen.add(value)
        coord_state.last = value
        str_list.append(number_to_char(value))
        
        # 重置下级坐标状态
        self._reset_subordinate_states(coord_type, state)
    
    def _reset_subordinate_states(self, coord_type: str, state: Dict[str, '_CoordinateState']) -> None:
        """
        重置下级坐标状态
        
        Args:
            coord_type: 当前坐标类型
            state: 包含所有状态信息的字典
        """
        if coord_type == 'layer':
            for t in ['row', 'column']:
                state[t] = self._CoordinateState()
        elif coord_type == 'row':
            state['column'] = self._CoordinateState()

class SuitDataFormatter:
    """
    麻将花色数据格式化工具类
    
    功能：
    - 处理位置数据和花色数据的组合
    - 添加适当的分隔符
    - 统一格式化输出
    """
    
    def __init__(self):
        self._separator = MahjongSplitChar.POSIT_SUIT_SPLIT_CHAR
    
    def format(self, data_list: List[RawPositionWithSuitData]) -> str:
        """
        格式化位置和花色数据
        
        Args:
            data_list: 包含 RawPositionWithSuitData 对象的列表
            
        Returns:
            格式化后的字符串，只花色信息
        """
        if self._has_suit_data(data_list):
            suit_str = self._extract_suit_data(data_list)
            return suit_str
        return ""
    
    def _has_suit_data(self, data_list: List[RawPositionWithSuitData]) -> bool:
        """
        检查数据列表中是否包含花色信息
        
        Args:
            data_list: 数据列表
            
        Returns:
            bool: 如果任何数据项包含花色信息则返回 True
        """
        return any(data.suit for data in data_list)
    
    def _extract_suit_data(self, data_list: List[RawPositionWithSuitData]) -> str:
        """
        从数据列表中提取花色字符串
        
        Args:
            data_list: 数据列表
            
        Returns:
            str: 连接后的花色字符串
        """
        return ''.join(data.suit for data in data_list)
