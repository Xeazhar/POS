import React from 'react';
import { FaHome } from "react-icons/fa";
import { MdTableBar, MdOutlineReorder  } from "react-icons/md";
import { CiCircleMore } from "react-icons/ci";
import { BiSolidDish } from "react-icons/bi";

const BottomNav = () => {
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-gray-900 p-2 h-16 flex justify-around">
    
        <button className="flex items-center justify-center text-white bg-gray-700 w-[200px] rounded-[20px]">
        <FaHome className="inline mr-2" size={20} /> 
        <p>Home</p>
        </button>

        <button className="flex items-center justify-center text-gray-400 bg-gray-800 w-[200px] rounded-[20px]">
        <MdOutlineReorder className="inline mr-2" size={20} /> 
        <p>Orders</p>
        </button>

        <button className="flex items-center justify-center text-gray-400 bg-gray-800 w-[200px] rounded-[20px]">
        <MdTableBar className="inline mr-2" size={20} /> 
        <p>Tables</p>
        </button>

        <button className="flex items-center justify-center text-gray-400 bg-gray-800 w-[200px] rounded-[20px]">
        <CiCircleMore className="inline mr-2" size={20} /> 
        <p>More</p>
        </button>


        <button className="absolute bottom-6 bg-yellow-500 text-white rounded-full p-3 items-center">
        <BiSolidDish size={30} />
     
        </button>
    
    
    </div>

    )
}

export default BottomNav;