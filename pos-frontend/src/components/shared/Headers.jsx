import React from 'react'
import { FaSearch, FaUserCircle, FaBell } from "react-icons/fa";
import logo from '../../assets/images/logo.png'

const Headers = () => {
  return (

    <header className ="flex justify-between items-center p-4 px-8 bg-gray-900 text-white">
        {/*LOGO*/}
        <div className="flex items-center gap-2">
            <img src={logo} alt="Logo" className="h-8 w-auto" />
            <h1 className="text-lg font-semibold text-white">POS</h1>
        </div>
        {/*SEARCH BAR*/}
        <div className="flex items-center gap-4 bg-gray-700 rounded rounded-[15px] px-5 py-2 w-[500px]">
            <FaSearch className="text-gray-400" />
            <input
                type="text"
                placeholder="Search..."
                className="bg-gray-700 outline-none text-white placeholder-gray-400"
                
                />
        </div>
        {/* Looged User */}
        <div className="flex items-center gap-4">
            <div className="bg-gray-700 rounded-[15px] p-3 cursor-pointer">
                <FaBell className="text-white text-2xl" />
            </div>
            <div className="flex items-center gap-3 cursor-pointer">
                <FaUserCircle className="text-white text-2xl" />
                <div>
                    <h1 className="text-md text-gray-200 font-semibold">Test User</h1>
                    <p className="text-sm text-gray-400 font-medium">Admin</p>
                </div>
            </div>
        </div>


    </header>
  );
};

export default Headers;