import React from "react";
import { popularDishes } from "../../constants";

const PopularDishes = () => {
  return (
    <div className="mt-6 pr-6">
      <div className="w-full rounded-lg bg-gray-900">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4">
          <h1 className="text-lg font-semibold tracking-wide text-gray-100">
            Popular Dishes
          </h1>

          <a href="#" className="text-sm font-semibold text-blue-500">
            View All
          </a>
        </div>

        {/* Dish list */}
        <div className="overflow-y-scroll h-[680px] scrollbar-hide">
          {
                popularDishes.map((dish) => (
                    <div
                    key={dish.id}
                    className="mx-6 mb-3 flex items-center gap-4 rounded-[15px] bg-gray-800 px-6 py-4"
                    >

                    <h1 className="text-gray-100 font-bold text-xl mr-5">
                      {dish.id <10 ? `0${dish.id}` : dish.id}
                    </h1>    


                    <img
                        src={dish.image}
                        alt={dish.name}
                        className="h-[50px] w-[50px] rounded-full object-cover"
                    />

                    <div className="flex flex-col items-start gap-1">
                        <h1 className="font-semibold tracking-wide text-gray-100">
                        {dish.name}
                        </h1>

                        <p className="text-sm text-gray-200 text-sm font-semibold mt-1">
                        <span className="text-gray-400">Orders: </span>    
                        {dish.numberOfOrders} 
                        </p>
                    </div>
                    </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PopularDishes;